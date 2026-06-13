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
- `mcp/` — the `reversee-mcp` npm package (stdio MCP bridge). The **app owns the MCP tool catalog** (`src/main/mcp/catalog.ts`); the bridge fetches it at runtime, so new tools ship with app updates, not bridge republishes.

## Conventions

- Releases are tag-driven: see [RELEASING.md](RELEASING.md). Don't hand-publish.
- macOS builds are signed + notarized in CI; never commit secrets or certs.
- Keep the proxy core Electron-free. Keep new MCP tools defined in the catalog (single source of truth for the bridge and the gated-mutation set).
