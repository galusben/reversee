// The authoritative MCP tool catalog, owned by the app. The bridge fetches
// this at startup (via the `list_tools` control method) and registers exactly
// these tools, so adding or changing a tool here reaches users through their
// already-installed bridge — no bridge republish needed. The bridge keeps its
// own frozen copy only as an offline fallback.
//
// `inputSchema` is a JSON Schema (what MCP's tools/list expects). Keep this
// module dependency-free so it can be unit-tested headlessly.

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Rejected unless the user enables "Allow MCP to Control the Proxy". */
  mutating?: boolean;
}

const noInput = { type: 'object', properties: {}, additionalProperties: false };

/**
 * Bumped when we ship a bridge with capabilities the app relies on. The bridge
 * compares its own version against this and advises the user to upgrade if it
 * is older. No npm registry calls are involved.
 */
export const RECOMMENDED_BRIDGE_VERSION = '2.0.0';

export const MCP_TOOL_CATALOG: McpToolDef[] = [
  {
    name: 'get_status',
    description:
      'Current Reversee state: app version, whether the proxy is running, listen/destination config, traffic and breakpoint counts.',
    inputSchema: noInput,
  },
  {
    name: 'get_config',
    description: 'Full Reversee proxy configuration (listen/destination, interceptors, rewrite flags).',
    inputSchema: noInput,
  },
  {
    name: 'update_config',
    description:
      'Update Reversee configuration. Accepts a partial settings object; unknown keys and invalid values are ignored. ' +
      'Keys: listenProtocol/destProtocol (http|https), listenPort/destPort (1-65535), dest (host), ' +
      'interceptRequest/interceptResponse (bool), requestInterceptor/responseInterceptor (JS source), ' +
      'rewriteRedirects/rewriteHost/allowSelfSignedUpstream (bool). ' +
      'Requires "Allow MCP to Control the Proxy" enabled in the app. Returns the resulting config.',
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'object', description: 'Partial settings object' } },
      required: ['patch'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'start_proxy',
    description: 'Start the reverse proxy with the current configuration. Requires control to be enabled in the app.',
    inputSchema: noInput,
    mutating: true,
  },
  {
    name: 'stop_proxy',
    description: 'Stop the reverse proxy. Requires control to be enabled in the app.',
    inputSchema: noInput,
    mutating: true,
  },
  {
    name: 'restart_proxy',
    description:
      'Restart the proxy worker process (also recovers from a wedged interceptor). Requires control to be enabled in the app.',
    inputSchema: noInput,
    mutating: true,
  },
  {
    name: 'list_traffic',
    description:
      'List captured requests (newest last): method, URL, status, content type, total time. Bodies are elided; use get_traffic_entry for full details.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: 'Skip this many entries' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max entries to return (default 50)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_traffic_entry',
    description: 'Full details of one captured request: headers, bodies, timings, and a copy-pasteable curl command.',
    inputSchema: {
      type: 'object',
      properties: { trafficId: { type: 'integer', description: 'Id from list_traffic' } },
      required: ['trafficId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_breakpoints',
    description: 'List the configured breakpoint rules (URL regex + HTTP methods).',
    inputSchema: noInput,
  },
  {
    name: 'validate_setup',
    description: 'Run setup checks: destination configured, ports valid, root certificate present, proxy process state.',
    inputSchema: noInput,
  },
  {
    name: 'export_diagnostics',
    description:
      'Export diagnostics: versions, platform, full settings, proxy state, traffic count, breakpoints, log location.',
    inputSchema: noInput,
  },
];

/** Tools rejected unless the user enables "Allow MCP to Control the Proxy". Derived from the catalog. */
export const MCP_MUTATING_METHODS: ReadonlySet<string> = new Set(
  MCP_TOOL_CATALOG.filter((t) => t.mutating).map((t) => t.name)
);
