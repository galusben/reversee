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
 * onto >= 2.1.0. The bridge reports its own version in the handshake and the
 * app emits the advisory below — so even the old 2.0.0 bridge (which has no
 * advisory code of its own but passes get_status through verbatim) surfaces
 * it. No npm registry calls are involved.
 *
 * INVARIANT: this must never exceed the highest `reversee-mcp` version
 * **published to npm**. Users upgrade with `npx -y reversee-mcp`, which can
 * only ever give them what the registry has; pointing this at an unpublished
 * version makes the advisory unsatisfiable, so every user is told to upgrade
 * to something they cannot install, on every get_status, forever.
 *
 * Bumping `mcp/package.json` is therefore not enough — the bridge has to be
 * published too. `npm run check:bridge-version` verifies both halves against
 * the registry, and the release pipeline publishes the bridge on a tag. See
 * the "MCP bridge" section of RELEASING.md.
 */
export const RECOMMENDED_BRIDGE_VERSION = '2.1.0';

/** Numeric semver-ish compare of the release core (ignores pre-release tags). */
export function isOlderVersion(a: string, b: string): boolean {
  const core = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
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
 * pulled forward. Every version string here is derived from
 * RECOMMENDED_BRIDGE_VERSION so a bump cannot leave stale text behind.
 */
export function buildBridgeAdvisory(bridgeVersion: string | undefined): BridgeAdvisory {
  const outdated = !bridgeVersion || isOlderVersion(bridgeVersion, RECOMMENDED_BRIDGE_VERSION);
  if (!outdated) {
    return {
      upToDate: true,
      recommended: RECOMMENDED_BRIDGE_VERSION,
      reportedVersion: bridgeVersion,
    };
  }
  return {
    upToDate: false,
    recommended: RECOMMENDED_BRIDGE_VERSION,
    reportedVersion: bridgeVersion,
    note:
      `Your reversee-mcp bridge (${bridgeVersion ?? `pre-${RECOMMENDED_BRIDGE_VERSION}`}) is older than the recommended ` +
      `${RECOMMENDED_BRIDGE_VERSION}. The newer bridge receives tools added in app updates automatically. ` +
      'Restart your MCP client to upgrade — on npm 11.2+ that pulls the latest. On older npm, ' +
      'clear the cache once first:\n' +
      '  for d in ~/.npm/_npx/*/; do [ -e "$d/node_modules/reversee-mcp" ] && rm -rf "$d"; done',
  };
}

const BASE_CATALOG: McpToolDef[] = [
  {
    name: 'get_status',
    description:
      'Current Reversee state: app version, whether the proxy is running, listen/destination config, traffic and breakpoint counts.',
    inputSchema: noInput,
  },
  {
    name: 'get_config',
    description:
      'Full Reversee proxy configuration (listen/destination, interceptors, rewrite flags).',
    inputSchema: noInput,
  },
  {
    name: 'update_config',
    description:
      'Update Reversee configuration. Accepts a partial settings object; unknown keys and invalid values are ignored. ' +
      'Keys: listenProtocol/destProtocol (http|https), listenPort/destPort (1-65535), dest (host), ' +
      'interceptRequest/interceptResponse (bool), requestInterceptor/responseInterceptor (JS source), ' +
      'rewriteRedirects/rewriteHost/allowSelfSignedUpstream/enableGrpc/captureAll/captureVerifyUpstream (bool), ' +
      'upstreamTimeoutSec (0-3600; seconds to wait for the upstream response head before a 504, 0 = never), ' +
      'trafficCap (100-20000 requests kept), theme (system|light|dark), ' +
      'upstreamClientCertPath/upstreamClientKeyPath (PEM files for mutual TLS to the upstream), ' +
      'routes (array of {id, enabled, hostPattern?, pathPattern?, destProtocol, dest, destPort}: regex rules ' +
      'that send matching requests to a different upstream; first match wins), and ' +
      'mocks (array of {id, enabled, method?, pathPattern, statusCode, headers, body, bodyEncoding? ("base64" for binary), delayMs?}: canned responses ' +
      'served without contacting the upstream). routes and mocks replace the whole list and invalid rules are dropped; ' +
      'prefer add_mock / add_route / remove_rule, which take plain paths and apply at once. ' +
      'enableGrpc runs an HTTP/2 listener so native gRPC is proxied and decoded (against saved proto specs); ' +
      'HTTP/1.1 clients are still served on the same port. ' +
      'captureAll ("Capture anything") turns the listener into a regular HTTP/HTTPS proxy at http://127.0.0.1:<listenPort> (this machine only): ' +
      'a client configured with HTTP_PROXY/HTTPS_PROXY has every request captured and sent to the server it asked for, ' +
      'so dest is not needed. HTTPS is decrypted with certificates signed by the Reversee root CA, which the client must trust ' +
      "(a client that does not shows up as a failed CONNECT entry); servers' certificates are verified unless " +
      'captureVerifyUpstream is false. Routes, mocks, scripts and breakpoints still apply; gRPC mode does not. ' +
      'Proxy-behavior keys take effect the next time the proxy starts, except routes and mocks, which apply at once. ' +
      'Requires "Allow MCP to Control the Proxy" enabled in the app. Returns the resulting config. ' +
      'Each tab has its own proxy settings; theme, trafficCap and the MCP switches are shared by all tabs. ' +
      'To change a tab other than the active one, put its id in the patch: {"tab": "t2", "dest": "…"}.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description:
            'Partial settings object; may include "tab" (a tab id or name, see list_tabs)',
        },
      },
      required: ['patch'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'list_tabs',
    description:
      'List the open tabs. Each tab is an independent proxy session with its own listen port, destination, ' +
      'routes/mocks, scripts, breakpoints and captured traffic, so several tools can be debugged at once. ' +
      'Returns each tab\'s id ("t1", "t2", …; stable — prefer it over the name, which the user can change), ' +
      'unique name, running state, port, destination, request/in-flight/held counts, and which tab is active ' +
      '(shown in the window). Every tab-scoped tool takes an optional tab (id or name) and defaults to the active tab.',
    inputSchema: noInput,
  },
  {
    name: 'create_tab',
    description:
      'Open a new tab: a separate proxy session, so you can debug something without changing the tab the user is on. ' +
      'Takes any per-tab setting from update_config (dest, destProtocol, destPort, listenProtocol, listenPort, captureAll, …); ' +
      'listenPort defaults to the next port no other tab uses. The tab opens stopped and in the background unless ' +
      'activate is true. Names must be unique; by default the tab is named after its destination ("api.example.com", ' +
      'or "api.example.com #2" if that name is taken). Returns the tab summary, including its id. Requires control to be enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique tab name (optional)' },
        activate: { type: 'boolean', description: 'Show the tab in the window (default false)' },
        dest: { type: 'string' },
        destProtocol: { type: 'string', enum: ['http', 'https'] },
        destPort: { type: 'number' },
        listenProtocol: { type: 'string', enum: ['http', 'https'] },
        listenPort: { type: 'number' },
        captureAll: { type: 'boolean' },
      },
      additionalProperties: true,
    },
    mutating: true,
  },
  {
    name: 'rename_tab',
    description:
      'Rename a tab. Names are unique (case-insensitive) and cannot look like a tab id; an empty name restores the ' +
      'automatic name (from the destination). Requires control to be enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Tab id or current name; default: the active tab' },
        name: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'close_tab',
    description:
      'Close a tab: its proxy stops, its held requests are dropped and its captured traffic is discarded. ' +
      'Closing the last tab leaves one empty tab. Requires control to be enabled.',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Tab id (preferred) or name' } },
      required: ['tab'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'start_proxy',
    description:
      'Start the reverse proxy with the current configuration. Requires control to be enabled in the app.',
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
      'List captured requests (newest last): method, URL, status, content type, total time, response size. ' +
      'An entry with pending:true is still in flight (waiting on the upstream, streaming, or an open WebSocket). ' +
      'Bodies are elided; use get_traffic_entry for full details.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: 'Skip this many entries' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Max entries to return (default 50)',
        },
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
        text: {
          type: 'string',
          description: 'Free-text substring across method, host, URL, status, content-type',
        },
        method: { type: 'string', description: 'HTTP method (exact, case-insensitive)' },
        status: {
          description: 'Exact (404), class ("2xx"/"4xx"), or comparison (">=400", "<300")',
          anyOf: [{ type: 'integer' }, { type: 'string' }],
        },
        host: { type: 'string', description: 'Substring of the host the request went to' },
        urlContains: { type: 'string' },
        urlRegex: { type: 'string', description: 'Regex matched against the request URL' },
        contentType: { type: 'string', description: 'Substring of the response content-type' },
        header: {
          type: 'string',
          description: '"key" (present) or "key:value" (value contains), req or res',
        },
        bodyContains: { type: 'string', description: 'Substring in the request or response body' },
        minTotalMs: { type: 'number', description: 'Only requests at least this slow (ms)' },
        hasError: {
          type: 'boolean',
          description: 'Only failures (connector error or status >= 400)',
        },
        offset: { type: 'integer', minimum: 0 },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Max results (default 50)',
        },
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
      properties: {
        slowest: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'How many slowest to list (default 5)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_traffic_entry',
    description:
      'Full details of one captured request: headers, bodies, timings, a copy-pasteable curl command, the upstream ' +
      'target, any decoded JWTs found in its Authorization header or cookies, decoded gRPC messages, WebSocket ' +
      'messages (for an upgraded connection), and errors / console output of the user interceptors that ran. ' +
      'Long gRPC streams and WebSockets keep only their most recent messages; the counts give the totals seen.',
    inputSchema: {
      type: 'object',
      properties: {
        trafficId: { type: 'integer', description: 'Id from list_traffic or search_traffic' },
      },
      required: ['trafficId'],
      additionalProperties: false,
    },
  },
  {
    name: 'compare_requests',
    description:
      'Diff two captured exchanges (A vs B) to answer "why did this call work and that one fail": request line, ' +
      'status, request and response headers (by name, case-insensitive) and bodies. JSON bodies are pretty-printed ' +
      'with sorted keys before diffing, so key order does not count; binary bodies are compared by size and ' +
      'fingerprint. Returns a plain-language summary of the differences first, then per-field diffs and a unified ' +
      'diff of each body that differs. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        trafficIdA: {
          type: 'integer',
          description: 'The baseline exchange (e.g. the one that worked)',
        },
        trafficIdB: { type: 'integer', description: 'The exchange to compare against it' },
        ignoreHeaders: {
          type: 'array',
          items: { type: 'string' },
          description: 'Header names to leave out, e.g. ["date", "x-request-id"]',
        },
        includeUnchanged: {
          type: 'boolean',
          description: 'Also list headers that are equal on both sides (default false)',
        },
      },
      required: ['trafficIdA', 'trafficIdB'],
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
      'the fly, for mocking, fault injection, or header rewriting. The code runs synchronously per request with a ' +
      '1 second budget; errors and console.log output are recorded on the traffic entry (get_traffic_entry). ' +
      'Request interceptors can mutate `requestParams` (host, path, method, port, headers, body). Response ' +
      'interceptors can mutate `responseParams` (statusCode, headers, body) and read `requestParams`. ' +
      'Example (force a 500): `responseParams.statusCode = 500; responseParams.body = "{\\"error\\":\\"injected\\"}";`. ' +
      'Changes apply to the running proxy at once, no restart needed. Use try_interceptor first to check the ' +
      'code against a captured request. Requires control to be enabled in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['request', 'response'] },
        code: {
          type: 'string',
          description: 'Interceptor JavaScript. Omit to leave the code unchanged.',
        },
        enabled: { type: 'boolean', description: 'Turn this interceptor on or off.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'try_interceptor',
    description:
      'Dry-run interceptor JavaScript against a captured exchange without sending or saving anything. Returns ' +
      'the exchange after the script ran (`after`), a plain list of `changes`, any `error` the script threw, ' +
      'and its console output (`logs`). Use it to check a script before installing it with set_interceptor. ' +
      'A compressed response body reaches a response script decompressed (live too), with content-encoding dropped. ' +
      'Requires control to be enabled in the app (it runs code).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['request', 'response'] },
        trafficId: {
          type: 'number',
          description: 'Captured exchange to run against (list_traffic).',
        },
        code: {
          type: 'string',
          description: 'JavaScript to try. Omit to try the saved interceptor of that kind.',
        },
      },
      required: ['kind', 'trafficId'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'decode_jwt',
    description:
      'Decode a JWT (header + claims, with exp/iat parsed). Inspection only — the signature is not verified.',
    inputSchema: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          description:
            'The JWT string (with or without a "Bearer " prefix is fine — pass the token)',
        },
      },
      required: ['token'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_breakpoints',
    description:
      'List the configured breakpoint rules (URL regex + HTTP methods + phase: request or response).',
    inputSchema: noInput,
  },
  {
    name: 'list_rules',
    description:
      'List the route and mock rules in match order, each with its id and a plain-language summary. ' +
      'A mock answers matching requests itself (the upstream is never contacted); a route sends matching ' +
      'requests to a different upstream than the default destination. First enabled match wins, mocks before routes.',
    inputSchema: noInput,
  },
  {
    name: 'add_mock',
    description:
      'Answer matching requests with a canned response, without contacting the upstream. Use it to fake an ' +
      'endpoint, force an error status, or add latency. Takes effect immediately, also while the proxy runs. ' +
      'Example: {"path": "/api/flags", "body": {"beta": true}} returns that JSON with status 200 for /api/flags. ' +
      'Remove it with remove_rule when done. Requires control to be enabled in the app.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Request path to match, e.g. "/api/flags"' },
        pathMatch: {
          type: 'string',
          enum: ['exact', 'prefix', 'contains', 'regex'],
          description:
            'How path is compared with the request URL (path + query). "exact" (default) ignores any query string; ' +
            '"prefix" = starts with; "regex" = path is a regular expression.',
        },
        method: { type: 'string', description: 'HTTP method to match (default: any)' },
        status: { type: 'integer', description: 'Response status code (default 200)' },
        body: {
          description:
            'Response body. A string is sent as is; an object or array is sent as JSON with content-type application/json.',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Response headers',
        },
        delayMs: { type: 'integer', description: 'Wait this long before answering (0-600000)' },
        name: { type: 'string', description: 'Label shown in the app' },
        priority: {
          type: 'string',
          enum: ['first', 'last'],
          description: 'Where to insert it; the first matching mock wins (default "first")',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_mocks',
    description:
      'Record and replay: turn captured traffic into mock rules, so the same responses are served again with no ' +
      'upstream (run a frontend offline, or a test against fixed responses). One mock per method + URL; when a URL ' +
      'was captured more than once the latest response wins. A recorded URL with a query string matches only that ' +
      'query unless ignoreQuery is true. Headers are kept except hop-by-hop ones, content-length and date (and ' +
      'content-encoding, since the stored body is decompressed); binary bodies are kept as base64. Pending, failed, ' +
      'already-mocked, WebSocket, gRPC and truncated exchanges are skipped and reported. A saved mock for the same ' +
      'method and URL is updated in place; new ones go after the existing mocks. Takes effect immediately. ' +
      'Select entries with trafficIds and/or the search_traffic filters (none = all captured traffic). ' +
      'Undo with remove_rule. Requires control to be enabled in the app.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        trafficIds: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Only these captured requests (ids from search_traffic)',
        },
        ignoreQuery: {
          type: 'boolean',
          description: 'Match the recorded path with any query string (default false)',
        },
        enabled: { type: 'boolean', description: 'Save the mocks switched on (default true)' },
        text: { type: 'string' },
        method: { type: 'string' },
        status: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        host: { type: 'string' },
        urlContains: { type: 'string' },
        urlRegex: { type: 'string' },
        contentType: { type: 'string' },
        header: { type: 'string' },
        bodyContains: { type: 'string' },
        minTotalMs: { type: 'number' },
        hasError: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_route',
    description:
      'Send matching requests to a different upstream than the default destination, e.g. one path to a local ' +
      'service while the rest goes to staging. The request path is forwarded unchanged. Give path and/or host. ' +
      'Takes effect immediately, also while the proxy runs. ' +
      'Example: {"path": "/api/v2", "target": "http://localhost:3001"}. Requires control to be enabled in the app.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Upstream to send to: scheme, host and optional port, e.g. "http://localhost:3001"',
        },
        path: { type: 'string', description: 'Request path to match, e.g. "/api/v2"' },
        pathMatch: {
          type: 'string',
          enum: ['prefix', 'exact', 'contains', 'regex'],
          description: 'How path is compared with the request URL (default "prefix" = starts with)',
        },
        host: { type: 'string', description: 'Request Host header to match (without port)' },
        hostMatch: {
          type: 'string',
          enum: ['exact', 'regex'],
          description: 'How host is compared (default "exact", case-insensitive)',
        },
        name: { type: 'string', description: 'Label shown in the app' },
        priority: {
          type: 'string',
          enum: ['first', 'last'],
          description: 'Where to insert it; the first matching route wins (default "first")',
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_rule',
    description:
      'Enable or disable one route or mock by id (from list_rules) without deleting it. ' +
      'Requires control to be enabled in the app.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Rule id from list_rules' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'enabled'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_rule',
    description:
      'Delete one route or mock by id (from list_rules), or every route and mock with {"all": true}. ' +
      'Requires control to be enabled in the app.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Rule id from list_rules' },
        all: { type: 'boolean', description: 'Delete all routes and mocks' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_breakpoints',
    description:
      'Replace the breakpoint rules. A request-phase rule holds matching requests before they are forwarded; a ' +
      'response-phase rule holds the upstream response before the client sees it. Held exchanges wait until ' +
      'resumed (resume_held_request, or Continue in the app), so set rules only when you will resume them. ' +
      'Pass an empty array to clear. Requires control to be enabled in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Regex matched against the request URL' },
              methods: {
                type: 'array',
                items: { type: 'string' },
                description: 'HTTP methods to match (default: all common methods)',
              },
              phase: {
                type: 'string',
                enum: ['request', 'response'],
                description: 'What to hold (default "request")',
              },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      required: ['rules'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'list_held_requests',
    description:
      'List the requests/responses currently held at a breakpoint: id, phase, method, URL, headers, body, and ' +
      "(for a held response) status code. Without tab, every tab's held requests are listed (a held request " +
      'blocks a real client wherever it is); held ids are unique across tabs, so resume_held_request needs no tab.',
    inputSchema: noInput,
  },
  {
    name: 'resume_held_request',
    description:
      'Resume a held request or response, optionally edited first. For a held request you can change url, method, ' +
      'headers and body before it is forwarded; for a held response, statusCode, headers and body before the ' +
      'client receives it. Requires control to be enabled in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Id from list_held_requests' },
        edits: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Held request only' },
            method: { type: 'string', description: 'Held request only' },
            statusCode: { type: 'integer', description: 'Held response only' },
            headers: {
              type: 'object',
              description: 'Merged into the held headers; a null value deletes that header',
            },
            body: { type: 'string', description: 'Replacement body' },
          },
          additionalProperties: false,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    mutating: true,
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
    description:
      'Run setup checks: destination configured, ports valid, root certificate present and not expired, ' +
      'upstream client certificate readable, proxy process state.',
    inputSchema: noInput,
  },
  {
    name: 'regenerate_root_cert',
    description:
      'Replace the root CA that signs the HTTPS listener certificate (use when validate_setup reports it expired). ' +
      'Clients must trust the new root before HTTPS through Reversee works again. Returns the new validity. ' +
      'Requires control to be enabled in the app.',
    inputSchema: noInput,
    mutating: true,
  },
  {
    name: 'export_har',
    description:
      'Write captured traffic to a HAR 1.2 file (for sharing, diffing, or loading into browser devtools). ' +
      'Accepts the same filters as search_traffic to export a subset. Requires control to be enabled in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the .har file to write' },
        text: { type: 'string' },
        method: { type: 'string' },
        status: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        host: { type: 'string' },
        urlContains: { type: 'string' },
        urlRegex: { type: 'string' },
        contentType: { type: 'string' },
        header: { type: 'string' },
        bodyContains: { type: 'string' },
        minTotalMs: { type: 'number' },
        hasError: { type: 'boolean' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    mutating: true,
  },
  {
    name: 'export_diagnostics',
    description:
      'Export diagnostics: versions, platform, full settings, proxy state, traffic count, breakpoints, log location.',
    inputSchema: noInput,
  },
];

/**
 * Tools that act on one tab. They take an optional `tab` (id or name) and
 * default to the active tab. update_config is tab-scoped too, but its `tab`
 * travels inside `patch` (the bridge forwards only the patch).
 */
export const TAB_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  'get_status',
  'get_config',
  'start_proxy',
  'stop_proxy',
  'restart_proxy',
  'list_traffic',
  'search_traffic',
  'summarize_session',
  'set_interceptor',
  'list_breakpoints',
  'set_breakpoints',
  'list_rules',
  'add_mock',
  'record_mocks',
  'add_route',
  'update_rule',
  'remove_rule',
  'list_held_requests',
  'export_har',
  'validate_setup',
  'export_diagnostics',
]);

const TAB_PARAM = {
  type: 'string',
  description:
    'Tab to act on: a tab id like "t2" (preferred) or a tab name. Default: the active tab (see list_tabs).',
};

function withTabParam(tool: McpToolDef): McpToolDef {
  if (!TAB_SCOPED_TOOLS.has(tool.name)) return tool;
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...schema.properties, tab: TAB_PARAM },
    },
  };
}

export const MCP_TOOL_CATALOG: McpToolDef[] = BASE_CATALOG.map(withTabParam);

/** Tools rejected unless the user enables "Allow MCP to Control the Proxy". Derived from the catalog. */
export const MCP_MUTATING_METHODS: ReadonlySet<string> = new Set(
  MCP_TOOL_CATALOG.filter((t) => t.mutating).map((t) => t.name)
);
