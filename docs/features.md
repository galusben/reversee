# Features — for humans and for agents

Reversee exposes the same reverse-proxy debugger to two audiences: humans through
the desktop UI, and agents through the Model Context Protocol.

## Human / UI

- **Configure the proxy** — listen protocol (http/https) + port, destination
  protocol + host + port. Toggles: *rewrite host* (override the Host header),
  *rewrite redirects* (rewrite 3xx `Location`), *allow self-signed upstream*.
- **Start / stop** — from the settings bar; status shows the listen port or the
  error (e.g. `EADDRINUSE`).
- **Inspect traffic** — a table of method / URL / status / content-type; click a row
  for full request & response in the detail panes (headers, gzip/brotli-decoded and
  syntax-highlighted bodies, timings). Copy-as-curl from the context menu; scroll
  lock to stop auto-follow; clear all.
- **Interceptors** — toggle request/response interception and edit JavaScript in a
  Monaco editor to mutate `requestParams` (host, path, method, port, headers, body)
  or `responseParams` (statusCode, headers, body) live. User-code errors are
  sandboxed and don't crash the proxy.
- **Breakpoints** — hold requests matching a URL regex + HTTP methods; held requests
  land in a FIFO queue where you edit URL/headers/body and resume.
- **gRPC** — check *gRPC* in the settings bar to run an HTTP/2 listener (h2 via ALPN
  on https, cleartext h2c on http) that proxies native gRPC. Import `.proto`/`.desc`
  definitions (*gRPC → Proto Specs*; protobufjs, no `protoc`) and every message —
  unary and server/client/bidi streaming — is decoded into JSON in the detail pane's
  gRPC tab, with the `grpc-status` shown on the row. Matched by method
  (`/package.Service/Method`). gRPC mode is HTTP/2-only on that port.
- **Connect AI** — a dialog with the `npx reversee-mcp` setup, plus the toggle that
  gates agent control.
- **Root CA trust** — a locally generated root certificate so HTTPS interception is
  trusted.

The UI is React; state lives in Zustand stores and components under
`src/renderer/src/` (see [architecture.md](architecture.md)).

## Agent / MCP

Agents drive the running app through the `reversee-mcp` stdio bridge. Setup is in
[mcp/README.md](../mcp/README.md) and [../README.md](../README.md).

### The control model

- **Read-only tools are always available.** Mutating tools (change config, start /
  stop / restart the proxy) are **gated**: rejected unless the user enables
  "Allow MCP to Control the Proxy" in the app, or the app is launched headless with
  `--allow-mcp-control`.
- **Transport is local and authenticated** — a per-boot token over a Unix socket /
  Windows named pipe (mode 0600), never a TCP port. See
  [ADR 0003](adr/0003-gated-mcp-mutations-over-local-socket.md).
- **The app owns the tool catalog** and serves it to the bridge at startup, so new
  tools ship with app updates — see
  [ADR 0002](adr/0002-app-owns-mcp-tool-catalog.md).

### Tools

> Source of truth: `MCP_TOOL_CATALOG` in
> [`src/main/mcp/catalog.ts`](../src/main/mcp/catalog.ts). The table below is a
> summary — the catalog has the exact input schemas and descriptions.

| Tool | Purpose | Mutating? |
| --- | --- | --- |
| `get_status` | App version, proxy run state, listen/dest config, traffic & breakpoint counts. | no |
| `get_config` | Full proxy configuration. | no |
| `update_config` | Patch the configuration (partial settings object). | **yes** |
| `start_proxy` | Start the proxy with the current config. | **yes** |
| `stop_proxy` | Stop the proxy. | **yes** |
| `restart_proxy` | Restart the worker (recovers a wedged interceptor). | **yes** |
| `list_traffic` | Paged captured requests; bodies elided. | no |
| `search_traffic` | Filter requests server-side (method, status, URL/regex, content-type, header, body, timing, errors). | no |
| `summarize_session` | Aggregate view: status classes, methods, content types, top hosts, errors, slowest. | no |
| `get_traffic_entry` | One request in full: headers, bodies, timings, curl, upstream target, decoded JWTs, decoded gRPC. | no |
| `replay_request` | Re-send a captured request with optional edits (method/url/headers/body). | **yes** |
| `set_interceptor` | Install request/response interceptor JS for mocking / fault injection. | **yes** |
| `decode_jwt` | Decode a JWT's header and claims (inspection only). | no |
| `list_breakpoints` | The configured breakpoint rules. | no |
| `list_proto_specs` | Saved protobuf specs used to decode gRPC, plus compile errors. | no |
| `add_proto_spec` | Save a protobuf spec (`.proto` text or base64 FileDescriptorSet) for gRPC decoding. | **yes** |
| `remove_proto_spec` | Delete a saved protobuf spec by id. | **yes** |
| `validate_setup` | Setup checks: destination, ports, root cert, proxy process. | no |
| `export_diagnostics` | Versions, platform, settings, state, log location — for bug reports. | no |

19 tools; the 8 marked mutating are gated.

### Headless mode

`reversee --headless --allow-mcp-control` runs with no window — just the proxy + MCP
socket — until killed, for CI- or agent-driven automation. Set a distinct
`REVERSEE_USER_DATA` directory to isolate an agent's instance (and its control
socket) from a GUI instance.
