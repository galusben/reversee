# Features — for humans and for agents

Reversee exposes the same reverse-proxy debugger to two audiences: humans through
the desktop UI, and agents through the Model Context Protocol.

## Human / UI

- **Configure the proxy** — listen protocol (http/https) + port, destination
  protocol + host + port. Toggles: _rewrite host_ (override the Host header),
  _rewrite redirects_ (rewrite 3xx `Location`), _allow self-signed upstream_.
- **Capture anything** — the mode selector in the settings bar switches between
  _Forward to one server_ (a reverse proxy in front of one destination) and _Capture
  anything_: a regular HTTP proxy at `http://127.0.0.1:<port>`, reachable from this machine only. A client set up with
  `HTTP_PROXY` / `HTTPS_PROXY` has every request captured and sent to the server it
  asked for; no destination is configured. Plain HTTP arrives as absolute-form
  requests; HTTPS arrives as `CONNECT` and is decrypted with a certificate issued per
  host by the root CA (the client must trust the exported root certificate). A client
  that refuses the certificate is listed as a failed `CONNECT` row. Other protocols
  inside a tunnel are passed through untouched. Routes, mocks, scripts, breakpoints,
  replay and WebSockets work as usual; host and redirect rewriting do not apply, and
  gRPC decoding is not available (tunnels are HTTP/1.1). Server certificates are
  verified by default in this mode (Preferences). _How to connect_ shows ready-made
  commands.
- **Start / stop** — from the settings bar (or F5); status shows the listen port or
  the error (e.g. `EADDRINUSE`).
- **Inspect traffic** — a sortable table of method / host / URL / status / content-type /
  size / duration / start time; click a row (or use the arrow keys) for full request
  & response in the detail panes (headers, gzip/brotli/zstd-decoded and
  syntax-highlighted bodies, a timing waterfall). Requests appear while still in
  flight. Copy-as-curl, replay, and edit-and-replay from the context menu; scroll
  lock to stop auto-follow; clear all. The history size is configurable.
- **Streaming and WebSockets** — responses are streamed, so Server-Sent Events and
  large downloads behave as they would without the proxy. WebSocket upgrades are
  tunnelled and their messages (including permessage-deflate) listed per connection.
- **Routes and mocks** — _Routes & Mocks_ in the settings bar (Cmd/Ctrl+Shift+M). A
  mock answers matching requests with a status / headers / body you write (optionally
  delayed) without contacting any upstream; a route sends requests whose path or Host
  matches to a different upstream. Matches are plain choices (_is exactly_, _starts
  with_, _contains_) or a regex. Rules can be named, reordered (first match wins, mocks
  before routes), duplicated and switched off, and each shows how many captured
  requests it matches. Right-click a captured request for _Mock This Response…_ or
  _Route Requests Like This…_. Saving applies to the running proxy at once; no restart.
- **Plain HTTP on an HTTPS listener** — a client that sends `http://` to an `https`
  listen port gets a 400 explaining to use `https://`, instead of a dropped connection.
- **HAR** — export the listed requests to a HAR 1.2 file, or import one, from the
  toolbar or the File menu.
- **Preferences** — theme (system / light / dark), history size, upstream response
  timeout, upstream certificate verification, a client certificate for mutual TLS,
  and the root certificate's validity.
- **Scripts (interceptors)** — the **Scripts** toolbar button (Proxy → Scripts…,
  Cmd/Ctrl+Shift+J) opens one screen for the request script and the response
  script: JavaScript that mutates `requestParams` (host, path, method, port,
  headers, body) or `responseParams` (statusCode, headers, body). Each has an
  on/off switch, a Monaco editor, a list of what it can change and one-click
  examples. **Try it** dry-runs the draft on a captured request in the proxy
  worker and lists what changed, the error if it threw, and its `console.log`
  output; nothing is sent. Saving applies the scripts to the running proxy at
  once. Each run has a one-second budget. A compressed response body reaches the
  response script decompressed, and is then sent on without `content-encoding`.
  User-code errors and console output
  are recorded on the traffic entry (the request's Interceptor tab), and the
  toolbar button turns red when a script failed on the latest request.
- **Breakpoints** — hold requests, or responses, matching a URL regex + HTTP methods;
  held exchanges land in a FIFO queue where you edit URL/headers/body (or status)
  and resume.
- **gRPC** — check _gRPC_ in the settings bar to run an HTTP/2 listener (h2 via ALPN
  on https, cleartext h2c on http) that proxies native gRPC. Import `.proto`/`.desc`
  definitions (_gRPC → Proto Specs_; protobufjs, no `protoc`) and every message —
  unary and server/client/bidi streaming — is decoded into JSON in the detail pane's
  gRPC tab, with the `grpc-status` shown on the row. Matched by method
  (`/package.Service/Method`). HTTP/1.1 clients are still served on the same port
  (interceptors and breakpoints apply to them, not to HTTP/2 streams).
- **Connect AI** — a dialog with the `npx reversee-mcp` setup, plus the toggle that
  gates agent control.
- **Root CA trust** — a locally generated root certificate so HTTPS interception is
  trusted. The app warns when it is about to expire and can regenerate it; in
  packaged builds its private key is encrypted with the OS keychain.

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
> summary; **[mcp-tools.md](mcp-tools.md)** is the full reference (exact
> parameters, verbatim descriptions, examples, and agent workflows).

| Tool                   | Purpose                                                                                              | Mutating? |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | --------- |
| `get_status`           | App version, proxy run state, listen/dest config, traffic & breakpoint counts.                       | no        |
| `get_config`           | Full proxy configuration.                                                                            | no        |
| `update_config`        | Patch the configuration (partial settings object).                                                   | **yes**   |
| `start_proxy`          | Start the proxy with the current config.                                                             | **yes**   |
| `stop_proxy`           | Stop the proxy.                                                                                      | **yes**   |
| `restart_proxy`        | Restart the worker (recovers a wedged interceptor).                                                  | **yes**   |
| `list_traffic`         | Paged captured requests; bodies elided.                                                              | no        |
| `search_traffic`       | Filter requests server-side (method, status, URL/regex, content-type, header, body, timing, errors). | no        |
| `summarize_session`    | Aggregate view: status classes, methods, content types, top hosts, errors, slowest.                  | no        |
| `get_traffic_entry`    | One request in full: headers, bodies, timings, curl, upstream target, decoded JWTs, decoded gRPC.    | no        |
| `replay_request`       | Re-send a captured request with optional edits (method/url/headers/body).                            | **yes**   |
| `set_interceptor`      | Install request/response interceptor JS for mocking / fault injection; applies live.                 | **yes**   |
| `try_interceptor`      | Dry-run script code on a captured exchange: what it changes, errors, console output.                 | **yes**   |
| `decode_jwt`           | Decode a JWT's header and claims (inspection only).                                                  | no        |
| `list_breakpoints`     | The configured breakpoint rules.                                                                     | no        |
| `set_breakpoints`      | Replace the breakpoint rules (request or response phase).                                            | **yes**   |
| `list_rules`           | Mock and route rules in match order, with plain-language summaries.                                  | no        |
| `add_mock`             | Answer matching requests with a canned response; applies at once.                                    | **yes**   |
| `add_route`            | Send matching requests to a different upstream; applies at once.                                     | **yes**   |
| `update_rule`          | Enable or disable one mock or route by id.                                                           | **yes**   |
| `remove_rule`          | Delete one mock or route by id, or all of them.                                                      | **yes**   |
| `list_held_requests`   | Requests / responses currently held at a breakpoint.                                                 | no        |
| `resume_held_request`  | Resume a held request or response, optionally edited.                                                | **yes**   |
| `export_har`           | Write captured traffic (optionally filtered) to a HAR 1.2 file.                                      | **yes**   |
| `regenerate_root_cert` | Replace the root CA behind the HTTPS listener.                                                       | **yes**   |
| `list_proto_specs`     | Saved protobuf specs used to decode gRPC, plus compile errors.                                       | no        |
| `add_proto_spec`       | Save a protobuf spec (`.proto` text or base64 FileDescriptorSet) for gRPC decoding.                  | **yes**   |
| `remove_proto_spec`    | Delete a saved protobuf spec by id.                                                                  | **yes**   |
| `validate_setup`       | Setup checks: destination, ports, root cert, proxy process.                                          | no        |
| `export_diagnostics`   | Versions, platform, settings, state, log location — for bug reports.                                 | no        |

30 tools; the 17 marked mutating are gated.

### Headless mode

`reversee --headless --allow-mcp-control` runs with no window — just the proxy + MCP
socket — until killed, for CI- or agent-driven automation. Set a distinct
`REVERSEE_USER_DATA` directory to isolate an agent's instance (and its control
socket) from a GUI instance.
