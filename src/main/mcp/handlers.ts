// Control-socket method handlers, backed by main's stores. Thin: every method
// reads or calls the same code paths the renderer uses.
import { app } from 'electron';
import { getSettings, setSettings, getRootCertPem } from '../settings';
import { isValidPort } from '../../shared/settings-schema';
import { filterTraffic, summarizeTraffic, type TrafficFilter } from '../../shared/traffic-query';
import { decodeJwt, findTokens } from '../../shared/decode';
import { replayRequest, type ReplayOverrides } from '../replay';
import {
  MCP_TOOL_CATALOG,
  MCP_MUTATING_METHODS,
  RECOMMENDED_BRIDGE_VERSION,
  buildBridgeAdvisory,
} from './catalog';
import type { ControlHandler } from './control-server';
import type { ProxyHost } from '../proxy-host';
import type { TrafficStore } from '../traffic-store';
import type { StartProxyResult } from '../../shared/ipc';
import type { BreakpointRule, TrafficEntry } from '../../shared/types';

export { MCP_MUTATING_METHODS };

export interface McpHandlerContext {
  proxyHost: ProxyHost;
  trafficStore: TrafficStore;
  getBreakpointRules(): BreakpointRule[];
  startProxy(): Promise<StartProxyResult>;
  /** Store an entry and push it to the renderer (used by replay). */
  recordTraffic(entry: TrafficEntry): TrafficEntry;
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
    url: entry.request.url,
    statusCode: entry.response.statusCode,
    contentType: Array.isArray(contentType) ? contentType[0] : contentType,
    totalMs: entry.timings.total !== undefined ? entry.timings.total / 1_000_000 : undefined,
    error: entry.connectorError ? String(entry.connectorError) : undefined,
    replay: entry.replay || undefined,
  };
}

// Filter keys accepted by search_traffic (mirrors TrafficFilter).
function pickFilter(p: Record<string, unknown>): TrafficFilter {
  const f: TrafficFilter = {};
  for (const k of ['text', 'method', 'urlContains', 'urlRegex', 'contentType', 'header', 'bodyContains'] as const) {
    if (typeof p[k] === 'string') f[k] = p[k] as string;
  }
  if (typeof p['status'] === 'string' || typeof p['status'] === 'number') f.status = p['status'] as string | number;
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
    },
    response: {
      headers: entry.response.headers,
      body: bodyText(entry.response.body),
      decodeError: entry.response.decodeError,
      truncated: entry.response.truncated,
    },
    timings: entry.timings,
    decoded: decoded.length ? decoded : undefined,
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
        destination: `${settings.destProtocol}://${settings.dest}:${settings.destPort}`,
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
      const limit = Math.min(200, Math.max(1, typeof p['limit'] === 'number' ? (p['limit'] as number) : 50));
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
      if (!entry.request.target) throw new Error('that entry has no recorded upstream target to replay to');
      const replayed = await replayRequest(
        {
          target: entry.request.target,
          method: entry.request.method,
          url: entry.request.url,
          headers: entry.request.headers,
          body: entry.request.body,
        },
        p.overrides ?? {},
        getSettings().allowSelfSignedUpstream === false
      );
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
      return setSettings(patch);
    },

    decode_jwt: (params) => {
      const p = (params ?? {}) as { token?: string };
      if (typeof p.token !== 'string') throw new Error('token (string) is required');
      const decoded = decodeJwt(p.token);
      if (!decoded) throw new Error('not a well-formed JWT');
      return decoded;
    },

    list_breakpoints: () => ctx.getBreakpointRules(),

    validate_setup: () => {
      const settings = getSettings();
      const checks = [
        {
          name: 'destination-configured',
          ok: Boolean(settings.dest),
          detail: settings.dest || 'destination host is empty',
        },
        {
          name: 'listen-port-valid',
          ok: isValidPort(settings.listenPort),
          detail: String(settings.listenPort),
        },
        {
          name: 'dest-port-valid',
          ok: isValidPort(settings.destPort),
          detail: String(settings.destPort),
        },
        {
          name: 'root-certificate',
          ok: Boolean(getRootCertPem()),
          detail: getRootCertPem() ? 'root CA present' : 'root CA missing',
        },
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
      logFile: app.getPath('logs'),
    }),
  };
}
