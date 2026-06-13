// Control-socket method handlers, backed by main's stores. Thin: every method
// reads or calls the same code paths the renderer uses.
import { app } from 'electron';
import { getSettings, setSettings, getRootCertPem } from '../settings';
import { isValidPort } from '../../shared/settings-schema';
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

    get_traffic_entry: (params) => {
      const p = (params ?? {}) as { trafficId?: number };
      if (typeof p.trafficId !== 'number') throw new Error('trafficId (number) is required');
      const entry = ctx.trafficStore.get(p.trafficId);
      if (!entry) throw new Error(`no traffic entry with id ${p.trafficId}`);
      return {
        ...trafficSummary(entry),
        request: {
          headers: entry.request.headers,
          body: bodyText(entry.request.body),
          curl: entry.request.curl,
          truncated: entry.request.truncated,
        },
        response: {
          headers: entry.response.headers,
          body: bodyText(entry.response.body),
          decodeError: entry.response.decodeError,
          truncated: entry.response.truncated,
        },
        timings: entry.timings,
      };
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
