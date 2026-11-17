# Architecture — where to find what

Reversee is an Electron app whose job is to run a reverse proxy and let both
humans (the UI) and agents (MCP) inspect and control it. The design keeps the
proxy logic isolated and headless-testable, and exposes a small, audited surface
to the renderer and to agents.

## Process model

```
                         ┌──────────────────────────────────────┐
                         │            Electron MAIN              │
                         │  src/main/index.ts (lifecycle, IPC)   │
   ┌─────────────┐  IPC  │                                       │
   │  RENDERER   │◄─────►│  proxy-host.ts ──┐  settings.ts       │
   │ React UI    │       │  traffic-store   │  certs/  updater   │
   │ src/renderer│       │  windows  menu   │                    │
   └─────┬───────┘       │                  │   mcp/ control     │
         │ window.reversee│                 │   socket           │
   ┌─────▼───────┐       └────────┬─────────┴────────┬───────────┘
   │  PRELOAD    │                │ parentPort        │ unix socket /
   │ src/preload │       postMessage (typed)          │ named pipe (token)
   │ RevAPI      │                ▼                    ▼
   └─────────────┘   ┌────────────────────┐   ┌──────────────────────┐
                     │  PROXY WORKER      │   │  reversee-mcp BRIDGE │
                     │  utilityProcess    │   │  (stdio MCP server)  │
                     │  src/proxy/worker  │   │  mcp/src/cli.ts      │
                     │  + core/ (no       │   └──────────┬───────────┘
                     │    Electron)       │              │ stdio
                     └────────────────────┘        ┌─────▼──────┐
                                                    │ MCP client │
                                                    │ (agent)    │
                                                    └────────────┘
```

Four boundaries, each typed:

- **Renderer ⇄ Main** — allowlisted IPC channels exposed through the preload bridge
  as `window.reversee` (typed `RevAPI`). The renderer never touches `ipcRenderer`.
- **Main ⇄ Proxy worker** — `parentPort.postMessage` with typed
  `WorkerInbound`/`WorkerOutbound` messages. The worker is a `utilityProcess` that
  can be killed and respawned to recover a wedged interceptor.
- **Main ⇄ MCP bridge** — a token-authenticated local Unix socket / Windows named
  pipe (never TCP). See [ADR 0003](adr/0003-gated-mcp-mutations-over-local-socket.md).
- **Bridge ⇄ agent** — stdio MCP.

## `src/main/` — Electron main process

System integration, state, and the MCP control surface.

| File                   | Responsibility                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`             | App lifecycle, IPC registration, proxy startup, MCP socket init, headless mode (`--headless`).                                                                           |
| `proxy-host.ts`        | Owns the proxy `utilityProcess`: spawn, message routing, restart, teardown.                                                                                              |
| `settings.ts`          | Persistence via electron-store; validation and change listeners.                                                                                                         |
| `traffic-store.ts`     | Ring buffer of captured traffic entries; the cap follows the `trafficCap` setting.                                                                                       |
| `replay.ts`            | Re-sends a stored request (optionally edited) to its upstream; used by the UI and the `replay_request` tool.                                                             |
| `record-mocks.ts`      | Record and replay: saves captured entries as mock rules (merged into settings); used by the UI and the `record_mocks` tool.                                              |
| `client-cert.ts`       | Reads the PEM client certificate + key configured for upstream mutual TLS.                                                                                               |
| `windows.ts`           | BrowserWindow creation and lifecycle.                                                                                                                                    |
| `menu.ts`              | Application menu, including the MCP setup item and cache reset.                                                                                                          |
| `updater.ts`           | electron-updater auto-update integration.                                                                                                                                |
| `certs/certs.ts`       | Root CA + per-boot localhost leaf (node-forge), expiry status, regeneration. The root key is encrypted at rest via `settings.ts` when a keychain is available.           |
| `cli-args.ts`          | CLI flag parsing (`--headless`, `--allow-mcp-control`).                                                                                                                  |
| `proto/proto-store.ts` | gRPC proto-spec store: hybrid storage (metadata `index.json` + `.proto`/`.desc` files under `userData/proto/`) and `compile()` (protobufjs) producing the worker bundle. |

### `src/main/mcp/` — control socket + tool catalog

| File                | Responsibility                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `catalog.ts`        | **The authoritative MCP tool catalog** + the bridge-version advisory. Single source of truth.              |
| `control-server.ts` | Local socket / named pipe server; per-boot token auth; rejects mutating methods unless control is enabled. |
| `handlers.ts`       | Implements each tool, backed by main's stores.                                                             |

## `src/preload/index.ts` — the renderer bridge

The only bridge. Exposes a typed `RevAPI` as `window.reversee` over an allowlist of
IPC channels (proxy control, settings, traffic, breakpoints, clipboard, and event
subscriptions). Raw `ipcRenderer` is never exposed.

## `src/renderer/` — React UI

Entry: `src/renderer/src/main.tsx` → `App.tsx`.

- **Stores** (`src/renderer/src/stores/`): `proxyStore.ts` (traffic mirror, proxy
  state, settings), `breakpointStore.ts` (rules, FIFO hit queue, compile errors),
  `uiStore.ts` (dialog state).
- **Stores** also include `protoSpecStore.ts` (saved gRPC proto specs + compile errors).
- **Components** (`src/renderer/src/components/`): `SettingsBar.tsx`,
  `TrafficTable.tsx`, `DetailPanes.tsx`, `BreakpointsDialog.tsx`,
  `BreakpointQueue.tsx`, `ScriptsDialog.tsx` (interceptor scripts), `ConnectAiDialog.tsx`,
  `ProtoSpecsDialog.tsx` (manage gRPC proto specs),
  `MonacoView.tsx` / `MonacoViewImpl.tsx` (JS editor for interceptors), and `ui/`
  (Radix-based primitives).

## `src/proxy/` — the proxy core (Electron-free)

`core/` is plain Node with **no Electron imports** (ESLint-enforced) so it can be
unit-tested headlessly — see [ADR 0001](adr/0001-electron-free-proxy-core.md).

| File                    | Responsibility                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker.ts`             | `utilityProcess` entry; speaks typed messages over `parentPort`; owns breakpoint gating and server lifecycle.                                                                                     |
| `core/server.ts`        | HTTP/1.1 HTTP/HTTPS listener; buffers request bodies; calls the optional gate (breakpoints) then proxies; hands upgrades to the WebSocket tunnel.                                                 |
| `core/proxy.ts`         | One exchange: route / mock matching, upstream request with header timeout, **streamed** response (buffered only for a response interceptor or breakpoint), traffic recording.                     |
| `core/forward.ts`       | "Capture anything" mode: absolute-form requests and `CONNECT` tunnels; terminates the client's TLS with a per-host certificate (requested from main) and feeds the stream to the normal handlers. |
| `core/capture.ts`       | Bounded, incrementally decompressed copy of a streamed body for the traffic view.                                                                                                                 |
| `core/rules.ts`         | Compiles and matches route rules (alternate upstreams) and mock rules (canned responses).                                                                                                         |
| `core/try-script.ts`    | Dry run of an interceptor script on a captured exchange (Scripts screen, `try_interceptor`); same engine, nothing sent.                                                                           |
| `core/websocket.ts`     | Forwards an Upgrade request and pipes the two sockets; records messages on the traffic entry.                                                                                                     |
| `core/ws-frames.ts`     | WebSocket frame parser + message assembler (fragments, permessage-deflate) working on a copy of the bytes.                                                                                        |
| `core/http2.ts`         | Listener used when `enableGrpc` is set: HTTP/2 streams forwarded over a shared upstream session with gRPC frame decode; HTTP/1.1 served on the same port via the `server.ts` handlers.            |
| `core/interceptor.ts`   | Runs user JS in a `node:vm` context with a time budget; returns errors and console output. Scope isolation only — not a security boundary.                                                        |
| `core/breakpoints.ts`   | Regex compilation and URL + method matching.                                                                                                                                                      |
| `core/curl.ts`          | Builds copy-pasteable curl commands from captured requests.                                                                                                                                       |
| `core/grpc-frames.ts`   | gRPC length-prefixed message framing (`[1B flag][4B len][protobuf]`), incremental `FrameAccumulator`, per-message gunzip, decode-against-type.                                                    |
| `core/grpc-registry.ts` | Rebuilds the compiled proto bundle (from main) and resolves a gRPC `:path` to request/response message types.                                                                                     |

## gRPC decoding

Protobuf wire bytes carry only field numbers, so gRPC is unreadable without the
schema. Reversee proxies native gRPC and decodes it from user-supplied proto
definitions, split across the process boundary to keep the proxy core
Electron-free:

- **Transport** (`src/proxy/core/http2.ts`) — when `enableGrpc` is set the worker
  runs this HTTP/2 listener instead of the HTTP/1.1 server (gRPC needs HTTP/2
  framing + trailers). `https` negotiates h2 via ALPN; `http` speaks cleartext h2c.
  For each stream it opens an upstream HTTP/2 stream, pipes bytes both ways
  **unmodified**, and copies frames through a `FrameAccumulator` to decode messages
  as they arrive (so streaming calls fill in incrementally), capturing the
  `grpc-status` trailer. It re-emits the `TrafficEntry` on each frame (the store
  upserts by `trafficId`). HTTP/1.1 is served on the same port through the regular
  HTTP/1.1 handlers: over TLS, ALPN picks the protocol per connection (Node's HTTP/2
  compatibility layer is deliberately not attached — it would send trailers twice);
  in cleartext, the first bytes are sniffed for the HTTP/2 preface.
- **Main** (`src/main/proto/proto-store.ts`) stores `.proto`/`.desc` specs and
  `compile()`s them (protobufjs — no `protoc`) into a serializable bundle: one
  namespace per spec plus a `/package.Service/Method` → type map. The bundle ships
  to the worker via the `set-proto-specs` `WorkerInbound` message — the same
  spec-compile-and-push pattern as breakpoints.
- **Decode** (`src/proxy/core/grpc-registry.ts` + `grpc-frames.ts`) rebuilds the
  bundle, resolves a call's `:path` to request/response types, and decodes each
  frame into JSON (`TrafficEntry.grpc`).
- **Surfaced** to humans in `DetailPanes.tsx` (the gRPC tab) + `TrafficTable.tsx`
  (badge + grpc-status) and to agents via `get_traffic_entry`. Specs are managed in
  the UI (`ProtoSpecsDialog`) and over MCP (`list_proto_specs` / `add_proto_spec` /
  `remove_proto_spec`).

`protobufjs` is bundled into both `index.js` and `proxyWorker.js` (electron-vite
bundles deps). Interceptors, breakpoints and mocks apply to HTTP/1.1 exchanges only;
HTTP/2 streams are passed through unmodified.

## Traffic entries over time

The worker reports one exchange more than once — pending, streaming progress, done —
tagged with a `streamId`. Main (`recordTraffic` in `index.ts`) maps that id to the
`trafficId` it assigned, so later notifies update the same entry; `pending` on the
entry is true until the final one. A fast exchange is reported once, when it ends.

## `src/shared/` — cross-process contracts

- `ipc.ts` — the `RevAPI` interface, `WorkerInbound`/`WorkerOutbound` message
  types, and IPC channel names (`domain:action`).
- `types.ts` — core types: `ProxySettings`, `RequestParams`, `TrafficEntry`,
  `BreakpointRule`, `Headers`, `Logger`, and the gRPC types (`GrpcView`,
  `ProtoSpec`, `GrpcProtoBundle`).
- `settings-schema.ts` — `AppSettings` shape, defaults, and sanitization (port
  range, protocol enum, booleans, route and mock rules).
- `record-mocks.ts` — record and replay: captured exchanges → mock rules (dedupe,
  header filtering, base64 for binary bodies, skip reasons) and the merge into the
  saved mocks; pure, so the dialog's preview and main's save run the same code.
- `har.ts` — HAR 1.2 export / import; `timings.ts` — timing phases for the waterfall
  and HAR; `breakpoint-id.ts` — rule ids shared by the UI and MCP.

## `mcp/` — the `reversee-mcp` bridge (separate npm package)

| File             | Responsibility                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `src/cli.ts`     | stdio MCP server entry; fetches the catalog from the running app, falls back to the frozen copy. |
| `src/client.ts`  | ndjson client for the control socket; token auth, lifecycle, error recovery.                     |
| `src/catalog.ts` | Frozen fallback catalog (used only when the app is down).                                        |

The app owns the catalog and serves it to the bridge at startup, so tools added in
app updates reach agents without republishing the bridge —
[ADR 0002](adr/0002-app-owns-mcp-tool-catalog.md).

## Common change → files to touch

- **Add an MCP tool** — define it in `src/main/mcp/catalog.ts` (set `mutating: true`
  if it changes state), implement it in `src/main/mcp/handlers.ts`, and assert it in
  the catalog test (`tests/unit/`, see [TESTING.md](../TESTING.md)). The bridge and
  the gated-mutation set update automatically.
- **Add a setting** — extend `src/shared/settings-schema.ts` (shape + default +
  sanitization) and `ProxySettings`/`AppSettings` in `src/shared/`, wire it through
  `settings.ts`, surface it in `SettingsBar.tsx`, and consume it in the proxy
  (`src/proxy/core/`). Mention it in `update_config`'s description in `catalog.ts`.
- **Change proxy behavior** — work in `src/proxy/core/` (keep it Electron-free) and
  the typed worker messages in `src/shared/ipc.ts`.
- **Touch gRPC decoding** — framing/registry in `src/proxy/core/grpc-{frames,registry}.ts`
  (Electron-free), spec storage + protobufjs compile in `src/main/proto/proto-store.ts`,
  and the `set-proto-specs` worker message in `src/shared/ipc.ts`. See [gRPC decoding](#grpc-decoding).
- **Add a UI panel** — add a component under `src/renderer/src/components/`, hold its
  state in a store under `src/renderer/src/stores/`, and add any new IPC through
  `src/preload/index.ts` + the channel allowlist + `src/shared/ipc.ts`.
