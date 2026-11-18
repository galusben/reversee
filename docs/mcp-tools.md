# Reversee MCP tools — the full reference

Reversee ships a [Model Context Protocol](https://modelcontextprotocol.io) server
so AI agents (Claude Code, Cursor, or any MCP client) can inspect and control the
proxy. This page is the **complete tool reference**: every tool, its exact
parameters, the verbatim description an agent sees, and worked examples.

> **Source of truth:** `MCP_TOOL_CATALOG` in
> [`src/main/mcp/catalog.ts`](../src/main/mcp/catalog.ts). The app owns this
> catalog and serves it to the bridge at startup, so tools added in an app update
> reach agents automatically — no `reversee-mcp` reinstall. This page mirrors that
> catalog; if the two ever disagree, the catalog wins.

For a one-line setup and the security overview see [../README.md](../README.md)
and [../mcp/README.md](../mcp/README.md); for the human/agent split see
[features.md](features.md).

## Setup

With the Reversee app running:

```sh
# Claude Code
claude mcp add reversee -- npx -y reversee-mcp
```

```json
// Cursor — ~/.cursor/mcp.json
{ "mcpServers": { "reversee": { "command": "npx", "args": ["-y", "reversee-mcp"] } } }
```

## How access works

- **Read-only by default.** The 15 read tools are always available. The 21
  **mutating** tools (marked 🔒 below) are rejected until the user enables
  _Proxy Settings → Allow MCP to Control the Proxy_ in the app, or the app is
  launched headless with `--allow-mcp-control`.
- **Local and authenticated.** The bridge reaches the app over a per-boot token on
  a Unix domain socket / Windows named pipe (mode 0600) — never a TCP port. See
  [ADR 0003](adr/0003-gated-mcp-mutations-over-local-socket.md).
- **App not running?** Every call returns a clear "launch Reversee" message.

## The `trafficId` handle

Every captured request has a stable, monotonic `trafficId`. It is assigned once,
never reused, and never reset — not on _clear_, not on a proxy restart. It is the
durable handle you pass to `get_traffic_entry` and `replay_request`. Prefer it over
list positions, which shift as new traffic arrives.

## Tabs

The app can run several proxies at once, one per **tab**. Each tab has its own
listen port, destination, routes and mocks, scripts, breakpoints and traffic.

- **Every tab-scoped tool takes an optional `tab`.** That covers status, config,
  proxy control, traffic listing and search, interceptors, rules, breakpoints and
  HAR export. `tab` is an id (`"t2"`) or a tab name. It resolves by id first, then
  by name ignoring case. Names are unique, so the lookup is never ambiguous.
- **Without `tab` a tool acts on the active tab** (the one shown in the window), so
  prompts written for a single proxy keep working.
- **Prefer ids.** The user can rename a tab, but its id never changes.
- **Responses say which tab they acted on.** Tab-scoped results include
  `tab: { id, name }`, which tells you where a call landed when you relied on the
  default.
- **`update_config` takes `tab` inside `patch`**, because the bridge forwards only
  the patch: `{"patch": {"tab": "t2", "dest": "api.example.com"}}`. `theme`,
  `trafficCap` and the MCP switches are shared by all tabs.
- **Ids that cross tabs.** `trafficId` and held-request ids are unique across tabs.
  `get_traffic_entry`, `compare_requests`, `replay_request`, `try_interceptor` and
  `resume_held_request` find the right tab on their own. `list_held_requests`
  without `tab` lists every tab's held requests.
- An unknown `tab` is an error that lists the open tabs.

### `list_tabs`

> List the open tabs. Each tab is an independent proxy session with its own listen
> port, destination, routes/mocks, scripts, breakpoints and captured traffic.

No parameters. Returns `activeTabId` and, per tab: `id`, `name`, `active`,
`running`, `port` (while running), `listenPort`, `listenProtocol`, `captureAll`,
`destination`, `trafficCount`, `pendingCount`, `heldCount` and the last `error`.

### `create_tab` 🔒

> Open a new tab: a separate proxy session, so you can debug something without
> changing the tab the user is on.

| Param               | Type    | Required | Notes                                                                    |
| ------------------- | ------- | -------- | ------------------------------------------------------------------------ |
| `name`              | string  | no       | Unique name. Default: the destination (`api.test`, `api.test #2`, …).    |
| `activate`          | boolean | no       | Show it in the window. Default `false` (the user keeps their view).      |
| any per-tab setting | —       | no       | `dest`, `destPort`, `listenPort`, `captureAll`, … as in `update_config`. |

`listenPort` defaults to the next port no other tab uses. The tab opens stopped:
`start_proxy` with `tab: "<id>"`.

### `rename_tab` 🔒

| Param  | Type   | Required | Notes                                                                               |
| ------ | ------ | -------- | ----------------------------------------------------------------------------------- |
| `tab`  | string | no       | Default: the active tab.                                                            |
| `name` | string | yes      | Unique (case-insensitive), not shaped like an id; `""` restores the automatic name. |

### `close_tab` 🔒

| Param | Type   | Required | Notes                                             |
| ----- | ------ | -------- | ------------------------------------------------- |
| `tab` | string | yes      | The tab's proxy stops; held requests are dropped. |

Closing the last tab leaves one empty tab.

---

## Orientation & status

### `get_status`

> Current Reversee state: app version, whether the proxy is running,
> listen/destination config, traffic and breakpoint counts.

No parameters. Start here to learn whether the proxy is up and how much traffic has
been captured. `mode` is `forward` (one `destination`) or `capture-anything` (a
`proxyUrl` for clients to use as their HTTP/HTTPS proxy).

### `validate_setup`

> Run setup checks: destination configured, ports valid, root certificate present
> and not expired, upstream client certificate readable, proxy process state.

No parameters. Use when something isn't proxying to find the misconfiguration.

### `regenerate_root_cert` 🔒

> Replace the root CA that signs the HTTPS listener certificate (use when
> validate_setup reports it expired). Clients must trust the new root before
> HTTPS through Reversee works again. Returns the new validity. Requires control
> to be enabled in the app.

No parameters. A running HTTPS listener is restarted onto the new certificate.

### `export_diagnostics`

> Export diagnostics: versions, platform, full settings, proxy state, traffic
> count, breakpoints, log location.

No parameters. The one-shot bundle to attach to a bug report.

---

## Configuration & proxy control

### `get_config`

> Full Reversee proxy configuration (listen/destination, interceptors, rewrite
> flags).

No parameters.

### `update_config` 🔒

> Update Reversee configuration. Accepts a partial settings object; unknown keys
> and invalid values are ignored. Keys: listenProtocol/destProtocol (http|https),
> listenPort/destPort (1-65535), dest (host), interceptRequest/interceptResponse
> (bool), requestInterceptor/responseInterceptor (JS source),
> rewriteRedirects/rewriteHost/allowSelfSignedUpstream/enableGrpc/captureAll/captureVerifyUpstream (bool),
> upstreamTimeoutSec (0-3600; seconds to wait for the upstream response head
> before a 504, 0 = never), trafficCap (100-20000 requests kept), theme
> (system|light|dark), upstreamClientCertPath/upstreamClientKeyPath (PEM files
> for mutual TLS to the upstream), routes and mocks (see below). Proxy-behavior
> keys take effect the next time the proxy starts, except routes and mocks,
> which apply at once. Requires "Allow MCP to Control
> the Proxy" enabled in the app. Returns the resulting config.

`captureAll` ("Capture anything") turns the listener into a regular HTTP/HTTPS proxy
at `http://127.0.0.1:<listenPort>` (reachable from this machine only): a client configured with `HTTP_PROXY` /
`HTTPS_PROXY` has every request captured and sent to the server it asked for, so
`dest` is not needed. HTTPS is decrypted with certificates signed by the Reversee
root CA, which the client must trust; a client that does not appears as a failed
`CONNECT` entry. Server certificates are verified unless `captureVerifyUpstream` is
false. `get_status` then reports `mode: "capture-anything"` and a `proxyUrl`.

`routes` sends matching requests to a different upstream (first match wins);
`mocks` answers them without contacting any upstream. Each key replaces the whole
list, and a rule with an invalid field is dropped. For single rules prefer
[`add_mock`](#add_mock-) and [`add_route`](#add_route-), which take plain paths
instead of regular expressions. The stored form:

```json
{
  "routes": [
    {
      "id": "v2",
      "enabled": true,
      "pathPattern": "^/api/v2/",
      "destProtocol": "http",
      "dest": "localhost",
      "destPort": 4000
    }
  ],
  "mocks": [
    {
      "id": "flags",
      "enabled": true,
      "method": "GET",
      "pathPattern": "^/flags$",
      "statusCode": 200,
      "headers": { "content-type": "application/json" },
      "body": "{\"beta\":true}",
      "delayMs": 150
    }
  ]
}
```

| Param   | Type   | Required | Notes                                                     |
| ------- | ------ | -------- | --------------------------------------------------------- |
| `patch` | object | yes      | Partial settings object; see the keys in the description. |

```jsonc
// point the proxy at a new upstream on port 8443
{ "patch": { "dest": "api.staging.example.com", "destProtocol": "https", "destPort": 8443 } }
```

### `start_proxy` 🔒

> Start the reverse proxy with the current configuration. Requires control to be
> enabled in the app.

No parameters.

### `stop_proxy` 🔒

> Stop the reverse proxy. Requires control to be enabled in the app.

No parameters.

### `restart_proxy` 🔒

> Restart the proxy worker process (also recovers from a wedged interceptor).
> Requires control to be enabled in the app.

No parameters. Reach for this if an interceptor wedged the worker.

---

## Inspecting traffic

### `list_traffic`

> List captured requests (newest last): method, URL, status, content type, total
> time. Bodies are elided; use get_traffic_entry for full details.

| Param    | Type          | Required | Notes                               |
| -------- | ------------- | -------- | ----------------------------------- |
| `offset` | integer ≥ 0   | no       | Skip this many entries.             |
| `limit`  | integer 1–200 | no       | Max entries to return (default 50). |

### `search_traffic`

> Filter captured requests server-side so you fetch only what matters (avoids
> dumping everything). All filters combine with AND. Bodies are elided in results;
> use get_traffic_entry for full detail.

| Param          | Type              | Notes                                                                        |
| -------------- | ----------------- | ---------------------------------------------------------------------------- |
| `text`         | string            | Free-text substring across method, URL, status, content-type.                |
| `method`       | string            | HTTP method (exact, case-insensitive).                                       |
| `status`       | integer \| string | Exact (`404`), class (`"2xx"`/`"4xx"`), or comparison (`">=400"`, `"<300"`). |
| `host`         | string            | Substring of the host the request went to.                                   |
| `urlContains`  | string            | Substring of the request URL.                                                |
| `urlRegex`     | string            | Regex matched against the request URL.                                       |
| `contentType`  | string            | Substring of the response content-type.                                      |
| `header`       | string            | `"key"` (present) or `"key:value"` (value contains), request or response.    |
| `bodyContains` | string            | Substring in the request or response body.                                   |
| `minTotalMs`   | number            | Only requests at least this slow (ms).                                       |
| `hasError`     | boolean           | Only failures (connector error or status ≥ 400).                             |
| `offset`       | integer ≥ 0       | Skip this many matches.                                                      |
| `limit`        | integer 1–200     | Max results (default 50).                                                    |

```jsonc
// slow failing API calls only
{ "urlContains": "/api/", "status": ">=500", "minTotalMs": 1000 }
```

### `summarize_session`

> Aggregate view of all captured traffic: counts by status class and method,
> content types, top hosts, the error requests, and the slowest requests. Use this
> to orient before drilling in.

| Param     | Type         | Notes                                          |
| --------- | ------------ | ---------------------------------------------- |
| `slowest` | integer 1–50 | How many slowest requests to list (default 5). |

### `get_traffic_entry`

> Full details of one captured request: headers, bodies, timings, a
> copy-pasteable curl command, the upstream target, and any decoded JWTs found in
> its Authorization header or cookies.

| Param       | Type    | Required | Notes                                       |
| ----------- | ------- | -------- | ------------------------------------------- |
| `trafficId` | integer | yes      | Id from `list_traffic` or `search_traffic`. |

Returns the full request/response, plus decoded gRPC when a matching proto spec is
loaded and decoded JWTs when the request carries a bearer token or JWT cookie. A
WebSocket connection carries `webSocket.messages` (direction, opcode, text, size);
`interceptorErrors` / `interceptorLogs` report what the user interceptors did. In
summaries, `pending: true` marks an exchange still in flight and `mocked: true` one
answered by a mock rule.

### `decode_jwt`

> Decode a JWT (header + claims, with exp/iat parsed). Inspection only — the
> signature is not verified.

| Param   | Type   | Required | Notes                                                         |
| ------- | ------ | -------- | ------------------------------------------------------------- |
| `token` | string | yes      | The JWT string. A leading `Bearer ` is fine — pass the token. |

### `compare_requests`

> Diff two captured exchanges (A vs B) to answer "why did this call work and that
> one fail": request line, status, request and response headers (by name,
> case-insensitive) and bodies. JSON bodies are pretty-printed with sorted keys
> before diffing, so key order does not count; binary bodies are compared by size
> and fingerprint. Returns a plain-language summary of the differences first, then
> per-field diffs and a unified diff of each body that differs. Read-only.

| Param              | Type     | Required | Notes                                                            |
| ------------------ | -------- | -------- | ---------------------------------------------------------------- |
| `trafficIdA`       | integer  | yes      | The baseline exchange (e.g. the one that worked).                |
| `trafficIdB`       | integer  | yes      | The exchange to compare against it.                              |
| `ignoreHeaders`    | string[] | no       | Header names to leave out, e.g. `["date", "x-request-id"]`.      |
| `includeUnchanged` | boolean  | no       | Also list fields that are equal on both sides (default `false`). |

```jsonc
// compare_requests({ trafficIdA: 12, trafficIdB: 15, ignoreHeaders: ["date"] })
{
  "a": { "trafficId": 12, "method": "GET", "url": "/me", "status": "200" },
  "b": { "trafficId": 15, "method": "GET", "url": "/me", "status": "401" },
  "identical": false,
  "summary": [
    "status: 200 → 401",
    "request header authorization: \"Bearer eyJ…new\" → \"Bearer eyJ…old\"",
    "response header www-authenticate only in B: \"Bearer\"",
    "response body differs (40 → 36 bytes)",
  ],
  "requestHeaders": [{ "name": "authorization", "a": "…", "b": "…", "status": "changed" }],
  "responseBody": {
    "equal": false,
    "a": { "kind": "json", "bytes": 40 },
    "b": { "kind": "json", "bytes": 36 },
    "diff": "@@ -1,7 +1,4 @@\n {\n-  \"ok\": true,\n…",
  },
  // also: requestLine, status, responseHeaders, requestBody
}
```

Each field diff has a `status` of `changed`, `added` (only in B) or `removed` (only
in A). Bodies are compared as stored, after content-encoding decoding, so a gzip
response and an identical plain one compare equal (the `content-encoding` header
still shows as a difference). A body `kind` is `empty`, `json`, `text` or `binary`;
a JSON body cut at the capture cap is compared as text. The unified diff is capped
at 400 lines (`diffTruncated: true`).

---

## Acting on traffic

### `replay_request` 🔒

> Re-send a captured request to its upstream, optionally with edits — the agent
> way to test a hypothesis ("what if this header/body/status were different?").
> Records a new traffic entry and returns it. Requires control to be enabled in
> the app.

| Param               | Type    | Required | Notes                                                                 |
| ------------------- | ------- | -------- | --------------------------------------------------------------------- |
| `trafficId`         | integer | yes      | The captured request to replay.                                       |
| `overrides`         | object  | no       | Edits applied before sending (below).                                 |
| `overrides.method`  | string  | no       | Replacement HTTP method.                                              |
| `overrides.url`     | string  | no       | Request path, e.g. `/api/users?page=2`.                               |
| `overrides.headers` | object  | no       | Merged into the original headers; a `null` value deletes that header. |
| `overrides.body`    | string  | no       | Replacement request body.                                             |

```jsonc
// re-run request 42 as an authed request to page 2
{
  "trafficId": 42,
  "overrides": { "url": "/api/users?page=2", "headers": { "authorization": "Bearer <token>" } },
}
```

The replayed entry is flagged so you can tell it apart from live traffic, and it
gets its own `trafficId`.

### `export_har` 🔒

> Write captured traffic to a HAR 1.2 file (for sharing, diffing, or loading into
> browser devtools). Accepts the same filters as search_traffic to export a
> subset. Requires control to be enabled in the app.

| Param  | Type   | Required | Notes                                                  |
| ------ | ------ | -------- | ------------------------------------------------------ |
| `path` | string | yes      | Absolute path of the `.har` file to write.             |
| …      |        | no       | Any `search_traffic` filter (`status`, `hasError`, …). |

### `set_interceptor` 🔒

> Install (or clear/toggle) a request or response interceptor — arbitrary
> JavaScript that rewrites traffic on the fly, for mocking, fault injection, or
> header rewriting. The code runs once per request with a one-second budget. Request
> interceptors can mutate `requestParams` (host, path, method, port, headers,
> body). Response interceptors can mutate `responseParams` (statusCode, headers,
> body) and read `requestParams`. Example (force a 500):
> `responseParams.statusCode = 500; responseParams.body = "{\"error\":\"injected\"}";`.
> Changes apply to the running proxy at once, no restart needed. Requires control
> to be enabled in the app.

| Param     | Type                        | Required | Notes                                                                                  |
| --------- | --------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `kind`    | `"request"` \| `"response"` | yes      | Which interceptor to set.                                                              |
| `code`    | string                      | no       | Interceptor JavaScript. Omit to leave the code unchanged (e.g. just toggle `enabled`). |
| `enabled` | boolean                     | no       | Turn this interceptor on or off.                                                       |

```jsonc
// inject a 500 on every response, for fault-injection testing
{
  "kind": "response",
  "code": "responseParams.statusCode = 500; responseParams.body = '{\"error\":\"injected\"}';",
  "enabled": true,
}
```

You write real JavaScript — there is no DSL. The code runs once per matching
request with a one-second budget; a throw or a timeout is contained, does not crash the
proxy, and is recorded on the traffic entry together with any `console.log` output
(`get_traffic_entry` returns `interceptorErrors` and `interceptorLogs`).

The result is `{ kind, enabled, code, applied }`; `applied` says whether the
script is active on a running proxy or waiting for `start_proxy`.

### `try_interceptor` 🔒

> Dry-run interceptor JavaScript against a captured exchange without sending or
> saving anything. Returns the exchange after the script ran (`after`), a plain
> list of `changes`, any `error` the script threw, and its console output
> (`logs`). Requires control to be enabled in the app (it runs code).

| Param       | Type                        | Required | Notes                                                    |
| ----------- | --------------------------- | -------- | -------------------------------------------------------- |
| `kind`      | `"request"` \| `"response"` | yes      | Which kind of script this is.                            |
| `trafficId` | number                      | yes      | Captured exchange to run against (`list_traffic`).       |
| `code`      | string                      | no       | JavaScript to try. Omit to try the saved script instead. |

```jsonc
// check a script before installing it
{ "kind": "request", "trafficId": 12, "code": "requestParams.headers['x-debug'] = 'true'" }
// -> { "after": { "request": { … } }, "changes": ["header x-debug added: true"], "logs": [] }
```

A request trial starts from the request as the client sent it, even if a
request script was already running when it was captured. A compressed response
body is handed to a response script decompressed, live and in a trial alike, and
the `content-encoding` header is dropped, so whatever the script leaves is sent
plain.

---

## Mocks & routes

Per request, the first enabled mock that matches answers it; otherwise the first
enabled route that matches picks the upstream; otherwise the default destination
is used. Changes apply to the running proxy at once. Rules apply to HTTP/1.1
requests, not to HTTP/2 gRPC streams.

### `list_rules`

Mock and route rules in match order. Each has its `id` and a plain-language
`summary`, such as `any method, path is "/api/flags" -> 200`.

No parameters.

### `add_mock` 🔒

Answer matching requests with a canned response, without contacting the upstream.

| Parameter   | Type                      | Required | Description                                                                                       |
| ----------- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `path`      | string                    | yes      | Request path to match, e.g. `/api/flags`.                                                         |
| `pathMatch` | string                    | no       | `exact` (default; ignores the query string), `prefix`, `contains` or `regex`.                     |
| `method`    | string                    | no       | HTTP method (default: any).                                                                       |
| `status`    | integer 100–599           | no       | Response status (default 200).                                                                    |
| `body`      | string \| object \| array | no       | A string is sent as is; an object or array is sent as JSON with `content-type: application/json`. |
| `headers`   | object                    | no       | Response headers.                                                                                 |
| `delayMs`   | integer 0–600000          | no       | Wait before answering.                                                                            |
| `name`      | string                    | no       | Label shown in the app.                                                                           |
| `priority`  | `"first"` \| `"last"`     | no       | Where to insert it; the first matching mock wins (default `first`).                               |

```json
{ "path": "/api/payments", "pathMatch": "prefix", "method": "POST", "status": 503, "delayMs": 1500 }
```

Returns the stored rule (`added`) and whether it is `active now on the running
proxy` or waits for `start_proxy`.

### `record_mocks` 🔒

Record and replay: turn captured traffic into mocks, so the same responses are
served again with no upstream (a frontend running offline, a test against fixed
responses). Select entries with `trafficIds` and/or the
[`search_traffic`](#search_traffic) filters; with neither, all captured traffic is
recorded.

| Parameter     | Type      | Required | Description                                                                                                                       |
| ------------- | --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `trafficIds`  | integer[] | no       | Only these captured requests.                                                                                                     |
| `ignoreQuery` | boolean   | no       | One mock per path that matches any query string (default `false`: a recorded query matches exactly).                              |
| `enabled`     | boolean   | no       | Save the mocks switched on (default `true`).                                                                                      |
| _filters_     |           | no       | `text`, `method`, `status`, `host`, `urlContains`, `urlRegex`, `contentType`, `header`, `bodyContains`, `minTotalMs`, `hasError`. |

How a recording is made:

- One mock per method + URL; when a URL was captured more than once the latest
  response wins. Mocks for an exact URL with a query come before path-only ones.
- Status, headers and body are kept. Hop-by-hop headers, `content-length` and
  `date` are dropped, and `content-encoding` too, because the stored body is the
  decompressed one. Binary bodies are stored as base64 (`bodyEncoding: "base64"`).
  Only the first of several `Set-Cookie` headers is kept.
- Skipped, and reported in `skipped` with a reason: in-flight, failed,
  already-mocked, WebSocket, gRPC, `CONNECT`, 1xx and `304` exchanges, truncated
  bodies, bodies over 512 KB, and anything past 8 MB of bodies in one recording.
- A saved mock with the same method and pattern is updated in place (`replaced`);
  new ones go after the existing mocks (`created`). The rule list holds 200 mocks;
  what does not fit is counted in `overLimit`.

```json
{ "urlContains": "/api/", "ignoreQuery": true }
```

Returns `considered`, `created`, `replaced`, `overLimit`, `skipped`
(`[{ reason, count, trafficIds }]`), `mocks` (`[{ id, fromTrafficId, summary,
bodyBytes }]`, bodies omitted) and `applied`. Undo with
[`remove_rule`](#remove_rule-).

### `add_route` 🔒

Send matching requests to a different upstream. The request path is forwarded
unchanged. Give `path` and/or `host`.

| Parameter   | Type                  | Required | Description                                                          |
| ----------- | --------------------- | -------- | -------------------------------------------------------------------- |
| `target`    | string                | yes      | Scheme, host and optional port, e.g. `http://localhost:3001`.        |
| `path`      | string                | no       | Request path to match, e.g. `/api/v2`.                               |
| `pathMatch` | string                | no       | `prefix` (default), `exact`, `contains` or `regex`.                  |
| `host`      | string                | no       | Request Host header to match, without port.                          |
| `hostMatch` | string                | no       | `exact` (default, case-insensitive) or `regex`.                      |
| `name`      | string                | no       | Label shown in the app.                                              |
| `priority`  | `"first"` \| `"last"` | no       | Where to insert it; the first matching route wins (default `first`). |

```json
{ "path": "/api/v2", "target": "http://localhost:3001" }
```

### `update_rule` 🔒

Enable or disable one mock or route without deleting it.

| Parameter | Type    | Required | Description                |
| --------- | ------- | -------- | -------------------------- |
| `id`      | string  | yes      | Rule id from `list_rules`. |
| `enabled` | boolean | yes      | New state.                 |

### `remove_rule` 🔒

Delete one mock or route by `id`, or all of them with `{ "all": true }`.

| Parameter | Type    | Required | Description                  |
| --------- | ------- | -------- | ---------------------------- |
| `id`      | string  | no       | Rule id from `list_rules`.   |
| `all`     | boolean | no       | Delete every mock and route. |

## Breakpoints & gRPC

### `list_breakpoints`

> List the configured breakpoint rules (URL regex + HTTP methods + phase: request
> or response).

No parameters.

### `set_breakpoints` 🔒

> Replace the breakpoint rules. A request-phase rule holds matching requests
> before they are forwarded; a response-phase rule holds the upstream response
> before the client sees it. Held exchanges wait until resumed
> (resume_held_request, or Continue in the app), so set rules only when you will
> resume them. Pass an empty array to clear. Requires control to be enabled in
> the app.

| Param             | Type                        | Required | Notes                                       |
| ----------------- | --------------------------- | -------- | ------------------------------------------- |
| `rules`           | array                       | yes      | The complete rule list; `[]` clears it.     |
| `rules[].path`    | string                      | yes      | Regex matched against the request URL.      |
| `rules[].methods` | string[]                    | no       | HTTP methods (default: all common methods). |
| `rules[].phase`   | `"request"` \| `"response"` | no       | What to hold (default `"request"`).         |

### `list_held_requests`

> List the requests/responses currently held at a breakpoint: id, phase, method,
> URL, headers, body, and (for a held response) status code.

No parameters.

### `resume_held_request` 🔒

> Resume a held request or response, optionally edited first. For a held request
> you can change url, method, headers and body before it is forwarded; for a held
> response, statusCode, headers and body before the client receives it. Requires
> control to be enabled in the app.

| Param              | Type    | Required | Notes                                                          |
| ------------------ | ------- | -------- | -------------------------------------------------------------- |
| `id`               | integer | yes      | Id from `list_held_requests`.                                  |
| `edits.url`        | string  | no       | Held request only.                                             |
| `edits.method`     | string  | no       | Held request only.                                             |
| `edits.statusCode` | integer | no       | Held response only.                                            |
| `edits.headers`    | object  | no       | Merged into the held headers; a `null` value deletes a header. |
| `edits.body`       | string  | no       | Replacement body.                                              |

Example — inject an outage into one response:

```json
{ "id": 4, "edits": { "statusCode": 503, "body": "{\"error\":\"injected\"}" } }
```

### `list_proto_specs`

> List saved protobuf specs used to decode gRPC traffic (id, name, source) plus
> any compile errors.

No parameters.

### `add_proto_spec` 🔒

> Save a protobuf spec for decoding gRPC traffic. Provide raw .proto text (source
> "proto") or a base64-encoded FileDescriptorSet (source "descriptor"). Returns
> the updated spec list and compile errors. Requires "Allow MCP to Control the
> Proxy" enabled in the app.

| Param     | Type                        | Required | Notes                                                                     |
| --------- | --------------------------- | -------- | ------------------------------------------------------------------------- |
| `name`    | string                      | yes      | Label for the spec.                                                       |
| `source`  | `"proto"` \| `"descriptor"` | yes      | Content kind.                                                             |
| `content` | string                      | yes      | `.proto` text for `"proto"`; base64 FileDescriptorSet for `"descriptor"`. |

### `remove_proto_spec` 🔒

> Delete a saved protobuf spec by id. Requires "Allow MCP to Control the Proxy"
> enabled in the app.

| Param | Type   | Required | Notes                            |
| ----- | ------ | -------- | -------------------------------- |
| `id`  | string | yes      | Spec id from `list_proto_specs`. |

---

## Agent workflows

A few end-to-end patterns these tools were designed for:

- **Triage a session.** `summarize_session` to orient → `search_traffic`
  (`hasError: true` or `status: ">=400"`) to find the failures → `get_traffic_entry`
  on the interesting ids for full detail.
- **Test a fix hypothesis.** Find the failing request, then `replay_request` with a
  changed header/body/url and compare the new entry — no client changes needed.
- **Why did this one fail?** Find a working and a failing call to the same endpoint
  (`search_traffic`), then `compare_requests` with the working one as A: the summary
  names the differing status, headers and body fields.
- **Mock or inject faults.** `set_interceptor` (`response`) to force a status/body,
  drive the client, then clear it by setting `enabled: false`.
- **Debug auth.** `get_traffic_entry` surfaces decoded JWTs inline; `decode_jwt`
  inspects a token you have in hand (check `exp`/`iat`).
- **Debug alongside the user.** `create_tab` with your own `dest`/`listenPort`,
  `start_proxy` with `tab: "<id>"`, point your client at that port, and pass the same
  `tab` to `list_traffic` / `search_traffic`. When you are done, `close_tab`. The
  user's tab is never touched.
- **Decode gRPC.** `add_proto_spec` with your `.proto`, then `get_traffic_entry`
  returns messages as JSON, matched by method.

## Headless mode

For CI- or agent-driven runs with no UI:

```sh
# isolate the agent's instance with its own profile + control socket
REVERSEE_USER_DATA="$(mktemp -d)" reversee --headless --allow-mcp-control &
```

`--headless` implies MCP enabled and runs until killed; `--allow-mcp-control` is
the launch-time equivalent of the in-app control toggle. A distinct
`REVERSEE_USER_DATA` lets a headless agent instance coexist with a GUI instance —
each gets its own socket. See [../README.md](../README.md#headless-mode-for-agents).
