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
 * The bridge version the app wants users on. 2.1.0 is the first *generic*
 * bridge (it serves the app-owned catalog); the original 2.0.0 bridge had a
 * hardcoded tool list and cannot receive new tools, so we actively pull users
 * onto >= 2.1.0. The app reports its own bridge version in the handshake and
 * the app emits the advisory below — so even the old 2.0.0 bridge (which has
 * no advisory code of its own but passes get_status through verbatim) surfaces
 * it. No npm registry calls are involved.
 */
export const RECOMMENDED_BRIDGE_VERSION = '2.1.0';

/** Numeric semver-ish compare of the release core (ignores pre-release tags). */
export function isOlderVersion(a: string, b: string): boolean {
  const core = (v: string) => v.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [a0 = 0, a1 = 0, a2 = 0] = core(a);
  const [b0 = 0, b1 = 0, b2 = 0] = core(b);
  if (a0 !== b0) return a0 < b0;
  if (a1 !== b1) return a1 < b1;
  return a2 < b2;
}

export interface BridgeAdvisory {
  upToDate: boolean;
  recommended: string;
  reportedVersion?: string;
  note?: string;
}

/**
 * Advisory included in get_status. A missing bridgeVersion means an old bridge
 * (pre-2.1.0 didn't report one) — treat it as outdated so those users get
 * pulled forward.
 */
export function buildBridgeAdvisory(bridgeVersion: string | undefined): BridgeAdvisory {
  const outdated = !bridgeVersion || isOlderVersion(bridgeVersion, RECOMMENDED_BRIDGE_VERSION);
  if (!outdated) {
    return { upToDate: true, recommended: RECOMMENDED_BRIDGE_VERSION, reportedVersion: bridgeVersion };
  }
  return {
    upToDate: false,
    recommended: RECOMMENDED_BRIDGE_VERSION,
    reportedVersion: bridgeVersion,
    note:
      `Your reversee-mcp bridge (${bridgeVersion ?? 'pre-2.1.0'}) is older than the recommended ` +
      `${RECOMMENDED_BRIDGE_VERSION}. The newer bridge receives tools added in app updates automatically. ` +
      'Restart your MCP client to upgrade — on npm 11.2+ that pulls the latest. On older npm, ' +
      'clear the cache once first:\n' +
      '  for d in ~/.npm/_npx/*/; do [ -e "$d/node_modules/reversee-mcp" ] && rm -rf "$d"; done',
  };
}

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
    name: 'search_traffic',
    description:
      'Filter captured requests server-side so you fetch only what matters (avoids dumping everything). ' +
      'All filters combine with AND. Bodies are elided in results; use get_traffic_entry for full detail.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Free-text substring across method, URL, status, content-type' },
        method: { type: 'string', description: 'HTTP method (exact, case-insensitive)' },
        status: {
          description: 'Exact (404), class ("2xx"/"4xx"), or comparison (">=400", "<300")',
          anyOf: [{ type: 'integer' }, { type: 'string' }],
        },
        urlContains: { type: 'string' },
        urlRegex: { type: 'string', description: 'Regex matched against the request URL' },
        contentType: { type: 'string', description: 'Substring of the response content-type' },
        header: { type: 'string', description: '"key" (present) or "key:value" (value contains), req or res' },
        bodyContains: { type: 'string', description: 'Substring in the request or response body' },
        minTotalMs: { type: 'number', description: 'Only requests at least this slow (ms)' },
        hasError: { type: 'boolean', description: 'Only failures (connector error or status >= 400)' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max results (default 50)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'summarize_session',
    description:
      'Aggregate view of all captured traffic: counts by status class and method, content types, top hosts, ' +
      'the error requests, and the slowest requests. Use this to orient before drilling in.',
    inputSchema: {
      type: 'object',
      properties: { slowest: { type: 'integer', minimum: 1, maximum: 50, description: 'How many slowest to list (default 5)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_traffic_entry',
    description:
      'Full details of one captured request: headers, bodies, timings, a copy-pasteable curl command, the upstream ' +
      'target, and any decoded JWTs found in its Authorization header or cookies.',
    inputSchema: {
      type: 'object',
      properties: { trafficId: { type: 'integer', description: 'Id from list_traffic or search_traffic' } },
      required: ['trafficId'],
      additionalProperties: false,
    },
  },
  {
    name: 'replay_request',
    description:
      'Re-send a captured request to its upstream, optionally with edits — the agent way to test a hypothesis ' +
      '("what if this header/body/status were different?"). Records a new traffic entry and returns it. ' +
      'Requires control to be enabled in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        trafficId: { type: 'integer', description: 'The captured request to replay' },
        overrides: {
          type: 'object',
          description: 'Optional edits to apply before sending',
          properties: {
            method: { type: 'string' },
            url: { type: 'string', description: 'Request path, e.g. /api/users?page=2' },
            headers: {
              type: 'object',
              description: 'Merged into the original headers; a null value deletes that header',
            },
            body: { type: 'string', description: 'Replacement request body' },
          },
          additionalProperties: false,
        },
      },
      required: ['trafficId'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'set_interceptor',
    description:
      'Install (or clear/toggle) a request or response interceptor — arbitrary JavaScript that rewrites traffic on ' +
      'the fly, for mocking, fault injection, or header rewriting. The code runs per matching request in a sandbox. ' +
      'Request interceptors can mutate `requestParams` (host, path, method, port, headers, body). Response ' +
      'interceptors can mutate `responseParams` (statusCode, headers, body) and read `requestParams`. ' +
      'Example (force a 500): `responseParams.statusCode = 500; responseParams.body = "{\\"error\\":\\"injected\\"}";`. ' +
      'Requires control to be enabled in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['request', 'response'] },
        code: { type: 'string', description: 'Interceptor JavaScript. Omit to leave the code unchanged.' },
        enabled: { type: 'boolean', description: 'Turn this interceptor on or off.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'decode_jwt',
    description: 'Decode a JWT (header + claims, with exp/iat parsed). Inspection only — the signature is not verified.',
    inputSchema: {
      type: 'object',
      properties: { token: { type: 'string', description: 'The JWT string (with or without a "Bearer " prefix is fine — pass the token)' } },
      required: ['token'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_breakpoints',
    description: 'List the configured breakpoint rules (URL regex + HTTP methods).',
    inputSchema: noInput,
  },
  {
    name: 'list_proto_specs',
    description:
      'List saved protobuf specs used to decode gRPC traffic (id, name, source) plus any compile errors.',
    inputSchema: noInput,
  },
  {
    name: 'add_proto_spec',
    description:
      'Save a protobuf spec for decoding gRPC traffic. Provide raw .proto text (source "proto") or a ' +
      'base64-encoded FileDescriptorSet (source "descriptor"). Returns the updated spec list and compile errors. ' +
      'Requires "Allow MCP to Control the Proxy" enabled in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Label for the spec' },
        source: { type: 'string', enum: ['proto', 'descriptor'], description: 'Content kind' },
        content: {
          type: 'string',
          description: '.proto text for source "proto"; base64 FileDescriptorSet for "descriptor"',
        },
      },
      required: ['name', 'source', 'content'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'remove_proto_spec',
    description:
      'Delete a saved protobuf spec by id. Requires "Allow MCP to Control the Proxy" enabled in the app.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Spec id from list_proto_specs' } },
      required: ['id'],
      additionalProperties: false,
    },
    mutating: true,
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
