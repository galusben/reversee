# Reversee — guide for AI agents

Reverse-proxy web debugger. Electron 42 + React 19 + TypeScript, built with electron-vite. The proxy runs in a `utilityProcess`; an MCP server (`mcp/`) lets agents drive the app.

## Commands

```sh
npm install            # installs the root + mcp workspace
npm start              # run the app (electron-vite dev, HMR)
npm test               # Vitest: unit + integration + MCP end-to-end
npm run typecheck      # tsc for app and mcp
npm run lint           # eslint
npm run build          # build app into out/
npx playwright test    # app end-to-end (needs npm run build first)
npm run build:mcp      # build the reversee-mcp bridge
```

Always run `npm run lint` and `npm run typecheck` before committing; both gate CI.

## Testing — see [TESTING.md](TESTING.md)

Four layers: unit/integration + MCP e2e (Vitest, `tests/unit/`), app e2e (Playwright, `tests/e2e/`), packaged smoke (release-only, `tests/smoke/`). All but the packaged smoke run on every PR. **Read TESTING.md before adding or changing tests** — it says which layer a change belongs in and how the layers map to CI jobs.

## Layout

- `src/main/` — Electron main: windows, menu, settings (electron-store), proxy host, certs, updater, `mcp/` (control socket + handlers + tool catalog).
- `src/preload/` — the only renderer bridge; typed `RevAPI`, allowlisted IPC channels.
- `src/renderer/` — React UI (Zustand stores, Tailwind, Radix).
- `src/proxy/` — the proxy core (`core/`, plain Node, **no Electron imports** — enforced by ESLint so it stays headless-testable) + the `utilityProcess` worker.
- `src/shared/` — cross-process types, IPC contracts, settings schema.
- `src/main/proto/` — gRPC proto-spec store: hybrid storage (metadata `index.json` + `.proto`/`.desc` files under `userData/proto/`) and `compile()` (protobufjs) producing the worker bundle.
- `mcp/` — the `reversee-mcp` npm package (stdio MCP bridge). The **app owns the MCP tool catalog** (`src/main/mcp/catalog.ts`); the bridge fetches it at runtime, so new tools ship with app updates, not bridge republishes.

## gRPC

Reversee decodes gRPC using user-supplied protobuf definitions. The pieces:

- **Proto specs** are managed in `src/main/proto/proto-store.ts` (CRUD + compile). `compile()` turns saved `.proto`/`.desc` specs into a serializable bundle (one protobufjs namespace per spec) plus a `/package.Service/Method` → type map, shipped to the worker via the `set-proto-specs` `WorkerInbound` message — the same pattern as breakpoints.
- **Decoding** lives in the Electron-free core: `src/proxy/core/grpc-frames.ts` (length-prefixed `[1B flag][4B len][protobuf]` framing, incremental `FrameAccumulator`, per-message gunzip) and `src/proxy/core/grpc-registry.ts` (rebuilds the bundle and resolves a `:path` to request/response types). `protobufjs` is bundled into both `index.js` and `proxyWorker.js` (electron-vite bundles deps; no `protoc` needed).
- **Spec management** is wired end-to-end like breakpoints: IPC (`protoSpecsGet/Import/Remove`) + preload + `ProtoSpecsDialog`/`protoSpecStore` (renderer) + the `*_proto_spec` MCP tools (gated mutations).
- **Status:** spec management + the decode engine ship today; the HTTP/2 transport that captures live gRPC traffic is the next milestone (the proxy core is still HTTP/1.1). Decoding is exercised by unit tests until the transport lands.

## Conventions

- Releases are tag-driven: see [RELEASING.md](RELEASING.md). Don't hand-publish.
- macOS builds are signed + notarized in CI; never commit secrets or certs.
- Keep the proxy core Electron-free. Keep new MCP tools defined in the catalog (single source of truth for the bridge and the gated-mutation set).
- gRPC decoding (framing, registry) belongs in `src/proxy/core/` (Electron-free, next to the bytes); proto-spec storage and `protobufjs` compilation belong in `src/main/proto/`. Keep them split so the core stays headless-testable.
