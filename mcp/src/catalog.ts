// Catalog handling for the bridge. The app owns the authoritative catalog
// (served via the `list_tools` control method); this module fetches it and
// falls back to a frozen embedded copy only when the app is unreachable.
import type { ReverseeClient } from './client.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutating?: boolean;
}

export interface ResolvedCatalog {
  tools: ToolDef[];
  /** Bridge version the running app recommends; undefined when offline. */
  recommendedBridge?: string;
  /** True when the catalog came from the running app (vs the offline fallback). */
  fromApp: boolean;
}

const noInput = { type: 'object', properties: {}, additionalProperties: false };

// Frozen mirror of the app's catalog, used only when the app is not running so
// the agent still sees a meaningful tool list. The app's copy is authoritative
// whenever it is reachable, so drift here is harmless.
export const FALLBACK_CATALOG: ToolDef[] = [
  { name: 'get_status', description: 'Current Reversee state: app version, proxy running, config, traffic and breakpoint counts.', inputSchema: noInput },
  { name: 'get_config', description: 'Full Reversee proxy configuration.', inputSchema: noInput },
  {
    name: 'update_config',
    description: 'Update Reversee configuration (partial settings object). Requires "Allow MCP to Control the Proxy".',
    inputSchema: { type: 'object', properties: { patch: { type: 'object' } }, required: ['patch'], additionalProperties: false },
    mutating: true,
  },
  { name: 'start_proxy', description: 'Start the reverse proxy. Requires control enabled in the app.', inputSchema: noInput, mutating: true },
  { name: 'stop_proxy', description: 'Stop the reverse proxy. Requires control enabled in the app.', inputSchema: noInput, mutating: true },
  { name: 'restart_proxy', description: 'Restart the proxy worker. Requires control enabled in the app.', inputSchema: noInput, mutating: true },
  {
    name: 'list_traffic',
    description: 'List captured requests (bodies elided).',
    inputSchema: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
  },
  {
    name: 'get_traffic_entry',
    description: 'Full details of one captured request: headers, bodies, timings, curl.',
    inputSchema: { type: 'object', properties: { trafficId: { type: 'integer' } }, required: ['trafficId'], additionalProperties: false },
  },
  { name: 'list_breakpoints', description: 'List the configured breakpoint rules.', inputSchema: noInput },
  { name: 'validate_setup', description: 'Run setup checks (destination, ports, root cert, proxy process).', inputSchema: noInput },
  { name: 'export_diagnostics', description: 'Export diagnostics for bug reports.', inputSchema: noInput },
];

/** Fetches the catalog from the running app; falls back to the embedded copy. */
export async function resolveCatalog(client: ReverseeClient): Promise<ResolvedCatalog> {
  try {
    const res = (await client.call('list_tools')) as {
      tools?: ToolDef[];
      recommendedBridge?: string;
    };
    if (res && Array.isArray(res.tools) && res.tools.length > 0) {
      return { tools: res.tools, recommendedBridge: res.recommendedBridge, fromApp: true };
    }
  } catch {
    // App not running, or an older app without list_tools — use the fallback.
  }
  return { tools: FALLBACK_CATALOG, fromApp: false };
}

/** Numeric semver-ish compare of the release core (ignores pre-release tags). */
export function isOlder(a: string, b: string): boolean {
  const core = (v: string) => v.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [a0 = 0, a1 = 0, a2 = 0] = core(a);
  const [b0 = 0, b1 = 0, b2 = 0] = core(b);
  if (a0 !== b0) return a0 < b0;
  if (a1 !== b1) return a1 < b1;
  return a2 < b2;
}

/** Advisory appended to get_status when the bridge is older than recommended. */
export function versionAdvisory(
  bridgeVersion: string,
  recommendedBridge: string | undefined
): { upToDate: boolean; version: string; recommended?: string; note?: string } {
  if (recommendedBridge && isOlder(bridgeVersion, recommendedBridge)) {
    return {
      upToDate: false,
      version: bridgeVersion,
      recommended: recommendedBridge,
      note:
        `A newer reversee-mcp (>= ${recommendedBridge}) is available; you are on ${bridgeVersion}. ` +
        'Upgrade to latest by clearing the cached copy, then restart your MCP client:\n' +
        '  for d in ~/.npm/_npx/*/; do [ -e "$d/node_modules/reversee-mcp" ] && rm -rf "$d"; done',
    };
  }
  return { upToDate: true, version: bridgeVersion };
}
