// Control-socket method handlers, backed by main's stores. Thin: every method
// reads or calls the same code paths the renderer uses.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, setSettings } from '../settings';
import { isValidPort, regexError } from '../../shared/settings-schema';
import { ruleId } from '../../shared/breakpoint-id';
import {
  buildMockRule,
  buildRouteRule,
  describeMock,
  describeRoute,
  type MockInput,
  type RouteInput,
} from '../../shared/rule-input';
import { toHar } from '../../shared/har';
import { readClientCert } from '../client-cert';
import { filterTraffic, summarizeTraffic, type TrafficFilter } from '../../shared/traffic-query';
import { decodeJwt, findTokens } from '../../shared/decode';
import { runScriptTrial } from '../script-trial';
import { replayEntry, type ReplayOverrides } from '../replay';
import {
  MCP_TOOL_CATALOG,
  MCP_MUTATING_METHODS,
  RECOMMENDED_BRIDGE_VERSION,
  buildBridgeAdvisory,
} from './catalog';
import type { ControlHandler } from './control-server';
import type { ProxyHost } from '../proxy-host';
import type { TrafficStore } from '../traffic-store';
import type { ProtoStore } from '../proto/proto-store';
import type {
  BreakpointHit,
  BreakpointResume,
  ProtoSpecsResult,
  RootCertStatus,
  StartProxyResult,
} from '../../shared/ipc';
import type { BreakpointRule, GrpcMessage, Headers, TrafficEntry } from '../../shared/types';

export { MCP_MUTATING_METHODS };

export interface McpHandlerContext {
  proxyHost: ProxyHost;
  trafficStore: TrafficStore;
  getBreakpointRules(): BreakpointRule[];
  /** Replaces the rules everywhere: the proxy worker and the window. */
  setBreakpointRules(rules: BreakpointRule[]): void;
  /** Requests/responses currently held at a breakpoint. */
  getHeldHits(): BreakpointHit[];
  resumeHeld(id: number, params: BreakpointResume): void;
  getCertStatus(): RootCertStatus;
  regenerateRootCert(): Promise<RootCertStatus>;
  startProxy(): Promise<StartProxyResult>;
  protoStore: ProtoStore;
  /** Recompiles specs, pushes the bundle to the worker, and returns the new state. */
  syncProtoSpecs(): ProtoSpecsResult;
  /** Store an entry and push it to the renderer (used by replay). */
  recordTraffic(entry: TrafficEntry): TrafficEntry;
}

/** Routes and mocks in match order, each with a plain-language summary. */
function rulesView(running: boolean): Record<string, unknown> {
  const { routes, mocks, dest, destProtocol, destPort } = getSettings();
  return {
    note:
      'Per request the first enabled mock that matches answers it; otherwise the first enabled ' +
      'route that matches picks the upstream; otherwise the default destination is used. ' +
      'Rules apply to HTTP/1.1 requests (not HTTP/2 gRPC streams).',
    proxyRunning: running,
    defaultDestination: dest ? `${destProtocol}://${dest}:${destPort}` : null,
    mocks: mocks.map((m) => ({ ...m, summary: describeMock(m) })),
    routes: routes.map((r) => ({ ...r, summary: describeRoute(r) })),
  };
}

function appliedNote(ctx: McpHandlerContext): { applied: string } {
  return {
    applied: ctx.proxyHost.isRunning
      ? 'active now on the running proxy'
      : 'saved; takes effect when the proxy starts (start_proxy)',
  };
}

/** Decoded JSON when available, else the decode error — for agent-facing output. */
function grpcMessageView(m: GrpcMessage): unknown {
  return m.json ?? { decodeError: m.decodeError ?? 'no matching proto spec' };
}

function bodyText(body: Uint8Array | string | undefined): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
}

function trafficSummary(entry: TrafficEntry): Record<string, unknown> {
  const contentType = entry.response.headers['content-type'];
  return {
    trafficId: entry.trafficId,
    method: entry.request.method,
    host: entry.request.target?.host,
    url: entry.request.url,
    statusCode: entry.response.statusCode,
    contentType: Array.isArray(contentType) ? contentType[0] : contentType,
    totalMs: entry.timings.total !== undefined ? entry.timings.total / 1_000_000 : undefined,
    responseBytes: entry.response.size,
    error: entry.connectorError ? String(entry.connectorError) : undefined,
    ...(entry.grpc ? { grpcMethod: entry.grpc.method, grpcStatus: entry.grpc.status } : {}),
    ...(entry.ws ? { webSocket: true, webSocketMessages: entry.ws.messageCount } : {}),
    replay: entry.replay || undefined,
    // Still in flight: waiting for the upstream, streaming, or an open WebSocket.
    pending: entry.pending || undefined,
    mocked: entry.mocked || undefined,
    clientAborted: entry.clientAborted || undefined,
    interceptorError: entry.interceptorErrors?.length ? true : undefined,
  };
}

// Filter keys accepted by search_traffic (mirrors TrafficFilter).
function pickFilter(p: Record<string, unknown>): TrafficFilter {
  const f: TrafficFilter = {};
  for (const k of [
    'text',
    'method',
    'host',
    'urlContains',
    'urlRegex',
    'contentType',
    'header',
    'bodyContains',
  ] as const) {
    if (typeof p[k] === 'string') f[k] = p[k] as string;
  }
  if (typeof p['status'] === 'string' || typeof p['status'] === 'number')
    f.status = p['status'] as string | number;
  if (typeof p['minTotalMs'] === 'number') f.minTotalMs = p['minTotalMs'] as number;
  if (typeof p['hasError'] === 'boolean') f.hasError = p['hasError'] as boolean;
  return f;
}

function fullEntry(entry: TrafficEntry): Record<string, unknown> {
  const decoded = findTokens(entry);
  return {
    ...trafficSummary(entry),
    request: {
      headers: entry.request.headers,
      body: bodyText(entry.request.body),
      curl: entry.request.curl,
      target: entry.request.target,
      truncated: entry.request.truncated,
      bytes: entry.request.size,
    },
    response: {
      headers: entry.response.headers,
      body: bodyText(entry.response.body),
      decodeError: entry.response.decodeError,
      truncated: entry.response.truncated,
      bytes: entry.response.size,
    },
    webSocket: entry.ws
      ? {
          closed: entry.ws.closed ?? false,
          messageCount: entry.ws.messageCount,
          // The most recent messages; older ones are dropped past the capture cap.
          messages: entry.ws.messages,
        }
      : undefined,
    interceptorErrors: entry.interceptorErrors,
    interceptorLogs: entry.interceptorLogs,
    grpc: entry.grpc
      ? {
          method: entry.grpc.method,
          status: entry.grpc.status,
          statusMessage: entry.grpc.statusMessage,
          requestMessages: entry.grpc.requestMessages.map(grpcMessageView),
          responseMessages: entry.grpc.responseMessages.map(grpcMessageView),
        }
      : undefined,
    timings: entry.timings,
    decoded: decoded.length ? decoded : undefined,
  };
}

interface SetupCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** An expired (or unreadable) root CA makes every HTTPS client reject the listener. */
function rootCertCheck(ctx: McpHandlerContext): SetupCheck {
  const name = 'root-certificate';
  let status: RootCertStatus;
  try {
    status = ctx.getCertStatus();
  } catch {
    return { name, ok: false, detail: 'root CA missing' };
  }
  const day = status.notAfter.slice(0, 10);
  if (status.temporary) {
    return {
      name,
      ok: false,
      detail:
        `the stored root CA key could not be unlocked (${status.temporaryReason}); ` +
        'running on a temporary root that clients do not trust',
    };
  }
  if (status.expired) {
    return {
      name,
      ok: false,
      detail: `root CA expired on ${day} — regenerate it (regenerate_root_cert) and trust the new one`,
    };
  }
  return {
    name,
    ok: true,
    detail: status.expiringSoon
      ? `root CA expires soon: ${day} (${status.daysLeft} days left)`
      : `root CA valid until ${day}`,
  };
}

function clientCertCheck(settings: ReturnType<typeof getSettings>): SetupCheck {
  const name = 'upstream-client-certificate';
  try {
    return {
      name,
      ok: true,
      detail: readClientCert(settings) ? 'client certificate and key readable' : 'not configured',
    };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message };
  }
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** Validates the set_breakpoints input into rules (with the same ids the UI assigns). */
function parseBreakpointRules(input: unknown): BreakpointRule[] {
  if (!Array.isArray(input)) throw new Error('rules (array) is required; pass [] to clear');
  return input.map((raw, i) => {
    const r = (raw ?? {}) as { path?: unknown; methods?: unknown; phase?: unknown };
    if (typeof r.path !== 'string' || !r.path) throw new Error(`rules[${i}].path is required`);
    const bad = regexError(r.path);
    if (bad) throw new Error(`rules[${i}].path is not a valid regular expression: ${bad}`);
    const methods = Array.isArray(r.methods)
      ? r.methods.map((m) => String(m).toUpperCase())
      : HTTP_METHODS;
    if (methods.length === 0) throw new Error(`rules[${i}].methods must not be empty`);
    if (r.phase !== undefined && r.phase !== 'request' && r.phase !== 'response') {
      throw new Error(`rules[${i}].phase must be "request" or "response"`);
    }
    const phase = r.phase === 'response' ? 'response' : 'request';
    return { id: ruleId(r.path, methods, phase), path: r.path, methods, phase };
  });
}

function heldView(hit: BreakpointHit): Record<string, unknown> {
  return {
    id: hit.id,
    phase: hit.phase,
    method: hit.method,
    url: hit.url,
    statusCode: hit.statusCode,
    headers: hit.headers,
    body: bodyText(hit.body),
  };
}

export function createMcpHandlers(ctx: McpHandlerContext): Record<string, ControlHandler> {
  return {
    // The bridge calls this at startup to learn which tools to advertise and
    // which bridge version the app recommends. The app is the source of truth
    // for the tool catalog.
    list_tools: () => ({
      tools: MCP_TOOL_CATALOG,
      recommendedBridge: RECOMMENDED_BRIDGE_VERSION,
    }),

    get_status: (_params, conn) => {
      const settings = getSettings();
      return {
        bridge: buildBridgeAdvisory(conn.bridgeVersion),
        appVersion: app.getVersion(),
        running: ctx.proxyHost.isRunning,
        listenProtocol: settings.listenProtocol,
        listenPort: settings.listenPort,
        // 'capture-anything': an HTTP/HTTPS proxy for any server; 'forward': one destination.
        mode: settings.captureAll ? 'capture-anything' : 'forward',
        ...(settings.captureAll
          ? { proxyUrl: `http://localhost:${settings.listenPort}` }
          : { destination: `${settings.destProtocol}://${settings.dest}:${settings.destPort}` }),
        trafficCount: ctx.trafficStore.size,
        breakpointCount: ctx.getBreakpointRules().length,
      };
    },

    get_config: () => getSettings(),

    update_config: (params) => setSettings(params),

    start_proxy: async () => {
      const result = await ctx.startProxy();
      if (!result.ok) throw new Error(result.error.message);
      return { running: true, port: result.port };
    },

    stop_proxy: () => {
      ctx.proxyHost.stop();
      return { running: false };
    },

    restart_proxy: async () => {
      if (!ctx.proxyHost.isRunning) {
        const result = await ctx.startProxy();
        if (!result.ok) throw new Error(result.error.message);
        return { running: true, port: result.port };
      }
      const port = await ctx.proxyHost.restart();
      return { running: true, port };
    },

    list_traffic: (params) => {
      const p = (params ?? {}) as { offset?: number; limit?: number };
      const all = ctx.trafficStore.getAll();
      const offset = Math.max(0, p.offset ?? 0);
      const limit = Math.min(200, Math.max(1, p.limit ?? 50));
      return {
        total: all.length,
        offset,
        entries: all.slice(offset, offset + limit).map(trafficSummary),
      };
    },

    search_traffic: (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const matched = filterTraffic(ctx.trafficStore.getAll(), pickFilter(p));
      const offset = Math.max(0, typeof p['offset'] === 'number' ? (p['offset'] as number) : 0);
      const limit = Math.min(
        200,
        Math.max(1, typeof p['limit'] === 'number' ? (p['limit'] as number) : 50)
      );
      return {
        matched: matched.length,
        offset,
        entries: matched.slice(offset, offset + limit).map(trafficSummary),
      };
    },

    summarize_session: (params) => {
      const p = (params ?? {}) as { slowest?: number };
      const n = typeof p.slowest === 'number' ? Math.min(50, Math.max(1, p.slowest)) : 5;
      return summarizeTraffic(ctx.trafficStore.getAll(), n);
    },

    get_traffic_entry: (params) => {
      const p = (params ?? {}) as { trafficId?: number };
      if (typeof p.trafficId !== 'number') throw new Error('trafficId (number) is required');
      const entry = ctx.trafficStore.get(p.trafficId);
      if (!entry) throw new Error(`no traffic entry with id ${p.trafficId}`);
      return fullEntry(entry);
    },

    replay_request: async (params) => {
      const p = (params ?? {}) as { trafficId?: number; overrides?: ReplayOverrides };
      if (typeof p.trafficId !== 'number') throw new Error('trafficId (number) is required');
      const entry = ctx.trafficStore.get(p.trafficId);
      if (!entry) throw new Error(`no traffic entry with id ${p.trafficId}`);
      const replayed = await replayEntry(entry, p.overrides ?? {}, getSettings());
      return fullEntry(ctx.recordTraffic(replayed));
    },

    set_interceptor: (params) => {
      const p = (params ?? {}) as { kind?: string; code?: string; enabled?: boolean };
      if (p.kind !== 'request' && p.kind !== 'response') {
        throw new Error('kind must be "request" or "response"');
      }
      const patch: Record<string, unknown> = {};
      if (typeof p.code === 'string') {
        patch[p.kind === 'request' ? 'requestInterceptor' : 'responseInterceptor'] = p.code;
      }
      if (typeof p.enabled === 'boolean') {
        patch[p.kind === 'request' ? 'interceptRequest' : 'interceptResponse'] = p.enabled;
      }
      const saved = setSettings(patch);
      return {
        kind: p.kind,
        enabled: p.kind === 'request' ? saved.interceptRequest : saved.interceptResponse,
        code: p.kind === 'request' ? saved.requestInterceptor : saved.responseInterceptor,
        ...appliedNote(ctx),
      };
    },

    try_interceptor: async (params) => {
      const p = (params ?? {}) as { kind?: unknown; code?: unknown; trafficId?: unknown };
      if (typeof p.trafficId !== 'number') throw new Error('trafficId (number) is required');
      const settings = getSettings();
      const code =
        p.code ??
        (p.kind === 'response' ? settings.responseInterceptor : settings.requestInterceptor);
      const outcome = await runScriptTrial(
        ctx.proxyHost,
        ctx.trafficStore,
        p.kind,
        code,
        p.trafficId
      );
      if (!outcome.ok) throw new Error(outcome.error);
      return {
        after: outcome.after,
        changes: outcome.changes,
        error: outcome.error,
        logs: outcome.logs,
      };
    },

    decode_jwt: (params) => {
      const p = (params ?? {}) as { token?: string };
      if (typeof p.token !== 'string') throw new Error('token (string) is required');
      const decoded = decodeJwt(p.token);
      if (!decoded) throw new Error('not a well-formed JWT');
      return decoded;
    },

    list_breakpoints: () => ctx.getBreakpointRules(),

    set_breakpoints: (params) => {
      const p = (params ?? {}) as { rules?: unknown };
      const rules = parseBreakpointRules(p.rules);
      // Same id = same rule: keep the first.
      const unique = rules.filter((r, i) => rules.findIndex((x) => x.id === r.id) === i);
      ctx.setBreakpointRules(unique);
      return unique;
    },

    list_rules: () => rulesView(ctx.proxyHost.isRunning),

    add_mock: (params) => {
      const p = (params ?? {}) as MockInput & { priority?: unknown };
      const rule = buildMockRule(p);
      const { mocks } = getSettings();
      setSettings({ mocks: p.priority === 'last' ? [...mocks, rule] : [rule, ...mocks] });
      return { added: { ...rule, summary: describeMock(rule) }, ...appliedNote(ctx) };
    },

    add_route: (params) => {
      const p = (params ?? {}) as RouteInput & { priority?: unknown };
      const rule = buildRouteRule(p);
      const { routes } = getSettings();
      setSettings({ routes: p.priority === 'last' ? [...routes, rule] : [rule, ...routes] });
      return { added: { ...rule, summary: describeRoute(rule) }, ...appliedNote(ctx) };
    },

    update_rule: (params) => {
      const p = (params ?? {}) as { id?: unknown; enabled?: unknown };
      if (typeof p.id !== 'string') throw new Error('id (string) is required (see list_rules)');
      if (typeof p.enabled !== 'boolean') throw new Error('enabled (boolean) is required');
      const { routes, mocks } = getSettings();
      if (![...routes, ...mocks].some((r) => r.id === p.id)) {
        throw new Error(`no route or mock has id ${p.id} (see list_rules)`);
      }
      const toggle = <T extends { id: string; enabled: boolean }>(list: T[]): T[] =>
        list.map((r) => (r.id === p.id ? { ...r, enabled: p.enabled as boolean } : r));
      setSettings({ routes: toggle(routes), mocks: toggle(mocks) });
      return rulesView(ctx.proxyHost.isRunning);
    },

    remove_rule: (params) => {
      const p = (params ?? {}) as { id?: unknown; all?: unknown };
      const { routes, mocks } = getSettings();
      if (p.all === true) {
        setSettings({ routes: [], mocks: [] });
        return { removed: routes.length + mocks.length, ...rulesView(ctx.proxyHost.isRunning) };
      }
      if (typeof p.id !== 'string') throw new Error('id (string) is required (see list_rules)');
      if (![...routes, ...mocks].some((r) => r.id === p.id)) {
        throw new Error(`no route or mock has id ${p.id} (see list_rules)`);
      }
      setSettings({
        routes: routes.filter((r) => r.id !== p.id),
        mocks: mocks.filter((m) => m.id !== p.id),
      });
      return { removed: 1, ...rulesView(ctx.proxyHost.isRunning) };
    },

    list_held_requests: () => ctx.getHeldHits().map(heldView),

    resume_held_request: (params) => {
      const p = (params ?? {}) as {
        id?: number;
        edits?: {
          url?: string;
          method?: string;
          headers?: Record<string, string | null>;
          body?: string;
          statusCode?: number;
        };
      };
      if (typeof p.id !== 'number') throw new Error('id (number) is required');
      const hit = ctx.getHeldHits().find((h) => h.id === p.id);
      if (!hit) throw new Error(`nothing is held with id ${p.id} (see list_held_requests)`);
      const edits = p.edits ?? {};
      const headers: Headers = { ...hit.headers };
      for (const [k, v] of Object.entries(edits.headers ?? {})) {
        if (v === null) delete headers[k];
        else headers[k] = v;
      }
      ctx.resumeHeld(hit.id, {
        url: edits.url ?? hit.url,
        method: edits.method ?? hit.method,
        headers,
        body: edits.body ?? hit.body,
        statusCode: hit.phase === 'response' ? (edits.statusCode ?? hit.statusCode) : undefined,
      });
      return { resumed: hit.id, phase: hit.phase };
    },

    export_har: (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const file = p['path'];
      if (typeof file !== 'string' || !path.isAbsolute(file)) {
        throw new Error('path (absolute file path) is required');
      }
      const entries = filterTraffic(ctx.trafficStore.getAll(), pickFilter(p));
      fs.writeFileSync(file, JSON.stringify(toHar(entries, app.getVersion()), null, 2), 'utf8');
      return { path: file, entries: entries.length };
    },

    regenerate_root_cert: () => ctx.regenerateRootCert(),

    list_proto_specs: (): ProtoSpecsResult => ({
      specs: ctx.protoStore.list(),
      errors: ctx.protoStore.compile().errors,
    }),

    add_proto_spec: (params) => {
      const p = (params ?? {}) as { name?: string; source?: string; content?: string };
      if (
        typeof p.name !== 'string' ||
        (p.source !== 'proto' && p.source !== 'descriptor') ||
        typeof p.content !== 'string'
      ) {
        throw new Error('name, source ("proto"|"descriptor"), and content are required');
      }
      ctx.protoStore.add({
        name: p.name,
        source: p.source,
        content: p.source === 'descriptor' ? Buffer.from(p.content, 'base64') : p.content,
      });
      return ctx.syncProtoSpecs();
    },

    remove_proto_spec: (params) => {
      const p = (params ?? {}) as { id?: string };
      if (typeof p.id !== 'string') throw new Error('id (string) is required');
      ctx.protoStore.remove(p.id);
      return ctx.syncProtoSpecs();
    },

    validate_setup: () => {
      const settings = getSettings();
      const checks = [
        {
          name: 'destination-configured',
          ok: settings.captureAll || Boolean(settings.dest),
          detail: settings.captureAll
            ? 'not needed: capture-anything mode sends each request to the server the client asked for'
            : settings.dest || 'destination host is empty',
        },
        {
          name: 'listen-port-valid',
          ok: isValidPort(settings.listenPort),
          detail: String(settings.listenPort),
        },
        {
          name: 'dest-port-valid',
          ok: settings.captureAll || isValidPort(settings.destPort),
          detail: String(settings.destPort),
        },
        rootCertCheck(ctx),
        clientCertCheck(settings),
        {
          name: 'proxy-process',
          ok: true,
          detail: ctx.proxyHost.isRunning ? 'running' : 'stopped (start with start_proxy)',
        },
      ];
      return { ok: checks.every((c) => c.ok), checks };
    },

    export_diagnostics: () => ({
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      settings: getSettings(),
      proxyRunning: ctx.proxyHost.isRunning,
      trafficCount: ctx.trafficStore.size,
      breakpoints: ctx.getBreakpointRules(),
      heldAtBreakpoints: ctx.getHeldHits().length,
      logFile: app.getPath('logs'),
    }),
  };
}
