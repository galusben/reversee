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

- **Read-only by default.** The 11 read tools are always available. The 8
  **mutating** tools (marked 🔒 below) are rejected until the user enables
  *Proxy Settings → Allow MCP to Control the Proxy* in the app, or the app is
  launched headless with `--allow-mcp-control`.
- **Local and authenticated.** The bridge reaches the app over a per-boot token on
  a Unix domain socket / Windows named pipe (mode 0600) — never a TCP port. See
  [ADR 0003](adr/0003-gated-mcp-mutations-over-local-socket.md).
- **App not running?** Every call returns a clear "launch Reversee" message.

## The `trafficId` handle

Every captured request has a stable, monotonic `trafficId`. It is assigned once,
never reused, and never reset — not on *clear*, not on a proxy restart. It is the
durable handle you pass to `get_traffic_entry` and `replay_request`. Prefer it over
list positions, which shift as new traffic arrives.

---

## Orientation & status

### `get_status`

> Current Reversee state: app version, whether the proxy is running,
> listen/destination config, traffic and breakpoint counts.

No parameters. Start here to learn whether the proxy is up and how much traffic has
been captured.

### `validate_setup`

> Run setup checks: destination configured, ports valid, root certificate present,
> proxy process state.

No parameters. Use when something isn't proxying to find the misconfiguration.

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
> rewriteRedirects/rewriteHost/allowSelfSignedUpstream (bool). Requires "Allow MCP
> to Control the Proxy" enabled in the app. Returns the resulting config.

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `patch` | object | yes | Partial settings object; see the keys in the description. |

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

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `offset` | integer ≥ 0 | no | Skip this many entries. |
| `limit` | integer 1–200 | no | Max entries to return (default 50). |

### `search_traffic`

> Filter captured requests server-side so you fetch only what matters (avoids
> dumping everything). All filters combine with AND. Bodies are elided in results;
> use get_traffic_entry for full detail.

| Param | Type | Notes |
| --- | --- | --- |
| `text` | string | Free-text substring across method, URL, status, content-type. |
| `method` | string | HTTP method (exact, case-insensitive). |
| `status` | integer \| string | Exact (`404`), class (`"2xx"`/`"4xx"`), or comparison (`">=400"`, `"<300"`). |
| `urlContains` | string | Substring of the request URL. |
| `urlRegex` | string | Regex matched against the request URL. |
| `contentType` | string | Substring of the response content-type. |
| `header` | string | `"key"` (present) or `"key:value"` (value contains), request or response. |
| `bodyContains` | string | Substring in the request or response body. |
| `minTotalMs` | number | Only requests at least this slow (ms). |
| `hasError` | boolean | Only failures (connector error or status ≥ 400). |
| `offset` | integer ≥ 0 | Skip this many matches. |
| `limit` | integer 1–200 | Max results (default 50). |

```jsonc
// slow failing API calls only
{ "urlContains": "/api/", "status": ">=500", "minTotalMs": 1000 }
```

### `summarize_session`

> Aggregate view of all captured traffic: counts by status class and method,
> content types, top hosts, the error requests, and the slowest requests. Use this
> to orient before drilling in.

| Param | Type | Notes |
| --- | --- | --- |
| `slowest` | integer 1–50 | How many slowest requests to list (default 5). |

### `get_traffic_entry`

> Full details of one captured request: headers, bodies, timings, a
> copy-pasteable curl command, the upstream target, and any decoded JWTs found in
> its Authorization header or cookies.

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `trafficId` | integer | yes | Id from `list_traffic` or `search_traffic`. |

Returns the full request/response, plus decoded gRPC when a matching proto spec is
loaded and decoded JWTs when the request carries a bearer token or JWT cookie.

### `decode_jwt`

> Decode a JWT (header + claims, with exp/iat parsed). Inspection only — the
> signature is not verified.

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `token` | string | yes | The JWT string. A leading `Bearer ` is fine — pass the token. |

---

## Acting on traffic

### `replay_request` 🔒

> Re-send a captured request to its upstream, optionally with edits — the agent
> way to test a hypothesis ("what if this header/body/status were different?").
> Records a new traffic entry and returns it. Requires control to be enabled in
> the app.

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `trafficId` | integer | yes | The captured request to replay. |
| `overrides` | object | no | Edits applied before sending (below). |
| `overrides.method` | string | no | Replacement HTTP method. |
| `overrides.url` | string | no | Request path, e.g. `/api/users?page=2`. |
| `overrides.headers` | object | no | Merged into the original headers; a `null` value deletes that header. |
| `overrides.body` | string | no | Replacement request body. |

```jsonc
// re-run request 42 as an authed request to page 2
{ "trafficId": 42, "overrides": { "url": "/api/users?page=2", "headers": { "authorization": "Bearer <token>" } } }
```

The replayed entry is flagged so you can tell it apart from live traffic, and it
gets its own `trafficId`.

### `set_interceptor` 🔒

> Install (or clear/toggle) a request or response interceptor — arbitrary
> JavaScript that rewrites traffic on the fly, for mocking, fault injection, or
> header rewriting. The code runs per matching request in a sandbox. Request
> interceptors can mutate `requestParams` (host, path, method, port, headers,
> body). Response interceptors can mutate `responseParams` (statusCode, headers,
> body) and read `requestParams`. Example (force a 500):
> `responseParams.statusCode = 500; responseParams.body = "{\"error\":\"injected\"}";`.
> Requires control to be enabled in the app.

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | `"request"` \| `"response"` | yes | Which interceptor to set. |
| `code` | string | no | Interceptor JavaScript. Omit to leave the code unchanged (e.g. just toggle `enabled`). |
| `enabled` | boolean | no | Turn this interceptor on or off. |

```jsonc
// inject a 500 on every response, for fault-injection testing
{ "kind": "response", "code": "responseParams.statusCode = 500; responseParams.body = '{\"error\":\"injected\"}';", "enabled": true }
```

You write real JavaScript — there is no DSL. The code runs once per matching
request in a sandbox; a throw is contained and does not crash the proxy.

---

## Breakpoints & gRPC

### `list_breakpoints`

> List the configured breakpoint rules (URL regex + HTTP methods).

No parameters.

### `list_proto_specs`

> List saved protobuf specs used to decode gRPC traffic (id, name, source) plus
> any compile errors.

No parameters.

### `add_proto_spec` 🔒

> Save a protobuf spec for decoding gRPC traffic. Provide raw .proto text (source
> "proto") or a base64-encoded FileDescriptorSet (source "descriptor"). Returns
> the updated spec list and compile errors. Requires "Allow MCP to Control the
> Proxy" enabled in the app.

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | Label for the spec. |
| `source` | `"proto"` \| `"descriptor"` | yes | Content kind. |
| `content` | string | yes | `.proto` text for `"proto"`; base64 FileDescriptorSet for `"descriptor"`. |

### `remove_proto_spec` 🔒

> Delete a saved protobuf spec by id. Requires "Allow MCP to Control the Proxy"
> enabled in the app.

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Spec id from `list_proto_specs`. |

---

## Agent workflows

A few end-to-end patterns these tools were designed for:

- **Triage a session.** `summarize_session` to orient → `search_traffic`
  (`hasError: true` or `status: ">=400"`) to find the failures → `get_traffic_entry`
  on the interesting ids for full detail.
- **Test a fix hypothesis.** Find the failing request, then `replay_request` with a
  changed header/body/url and compare the new entry — no client changes needed.
- **Mock or inject faults.** `set_interceptor` (`response`) to force a status/body,
  drive the client, then clear it by setting `enabled: false`.
- **Debug auth.** `get_traffic_entry` surfaces decoded JWTs inline; `decode_jwt`
  inspects a token you have in hand (check `exp`/`iat`).
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
