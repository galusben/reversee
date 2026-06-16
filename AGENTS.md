# Reversee — guide for AI agents

Reverse-proxy web debugger. **Electron 42 + React 19 + TypeScript**, built with
electron-vite. It sits between a client and a destination server so you can see,
intercept, and edit HTTP/HTTPS traffic. The proxy runs in a `utilityProcess`; an
MCP server (`mcp/`) lets agents drive the running app.

This file is the canonical agent entry point (the vendor-neutral
[agents.md](https://agents.md) convention). It's a scannable hub — the deep
knowledge base lives in [`docs/`](docs/README.md).

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

## Where to find what

Full map with entry-point files and "common change → files to touch" recipes:
**[docs/architecture.md](docs/architecture.md)**.

- `src/main/` — Electron main: lifecycle, windows, menu, settings, proxy host,
  certs, updater, `mcp/` (control socket + handlers + tool catalog), and `proto/`
  (gRPC proto-spec store + protobufjs compile).
- `src/preload/` — the only renderer bridge; typed `RevAPI`, allowlisted IPC.
- `src/renderer/` — React UI (Zustand stores, Tailwind, Radix).
- `src/proxy/` — the proxy core (`core/`, plain Node, **no Electron imports**) +
  the `utilityProcess` worker.
- `src/shared/` — cross-process types, IPC contracts, settings schema.
- `mcp/` — the `reversee-mcp` npm package (stdio MCP bridge).

## Working agreements

- **Always run `npm run lint` and `npm run typecheck` before committing** — both
  gate CI.
- **Keep the proxy core Electron-free** (`src/proxy/core/` is ESLint-enforced so
  it stays headless-testable — see [ADR 0001](docs/adr/0001-electron-free-proxy-core.md)).
- **New MCP tools go in the catalog** (`src/main/mcp/catalog.ts`), the single
  source of truth for the bridge and the gated-mutation set — see
  [ADR 0002](docs/adr/0002-app-owns-mcp-tool-catalog.md).
- **Releases are tag-driven** — never hand-publish. See [RELEASING.md](RELEASING.md).
- Read [TESTING.md](TESTING.md) before adding or changing tests; it says which of
  the four layers a change belongs in.
- More: [docs/conventions.md](docs/conventions.md).

## Driving the app at runtime (MCP)

Agents inspect and control the running app over the Model Context Protocol via the
`reversee-mcp` bridge. Read-only tools (status, config, traffic, breakpoints,
diagnostics) are always available; mutating tools (start/stop/restart, config
changes) are **gated** behind "Allow MCP to Control the Proxy" / `--allow-mcp-control`.
The bridge talks to the app over a token-authenticated local socket — never TCP.

See **[docs/features.md](docs/features.md)** for the full capability catalog and
[mcp/README.md](mcp/README.md) for bridge setup.
