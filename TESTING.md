# Testing

Reversee has four test layers. All of them except the packaged smoke test run on every PR.

| Layer | Tool | Location | Run locally | Runs in CI |
| --- | --- | --- | --- | --- |
| Unit & integration | Vitest | `tests/unit/*.test.mjs` | `npm test` | `checks` job (every push/PR) |
| App end-to-end | Playwright (Electron) | `tests/e2e/*.spec.ts` | `npm run build && npx playwright test` | `e2e` (macOS) + `e2e-windows` |
| MCP end-to-end | Vitest (spawns the bridge) | `tests/unit/mcp-stdio.test.mjs` | `npm test` | `checks` job |
| Packaged smoke | Playwright | `tests/smoke/packaged.spec.ts` | (see below) | **Release only** (tag-triggered) |

`npm test` runs Vitest, which includes both the unit/integration suite and the MCP end-to-end (the latter builds and spawns the real bridge in `beforeAll`). `npm run lint` and `npm run typecheck` round out the `checks` job.

## What each layer covers

### Unit & integration (`tests/unit/`)
- **Proxy core** (`proxy.core`, `interceptor`, `curl`, `breakpoints`) — the request-forwarding logic, run headlessly against real `http`/`https` fixture servers (no Electron). This is the safety net the whole refactor was built on.
- **Traffic store** (`traffic-store`) — ring-buffer cap, eviction, body truncation.
- **MCP** — `control-server` (token handshake, gating, permissions), `mcp-catalog` (the app-owned tool catalog + derived mutating set), `mcp-bridge` (`resolveCatalog` against the real control server incl. offline fallback, version-advisory logic), `mcp-client` (the bridge's socket client against the real server).

### App end-to-end (`tests/e2e/`)
Playwright drives the built app (`out/`) through real user flows: launch + sandbox assertions, configure/start/proxy/inspect, request & response interceptors, breakpoint hold→edit→resume, invalid-port handling, settings persistence across relaunch, HTTPS listening, and EADDRINUSE surfacing. Needs `npm run build` first.

### MCP end-to-end (`tests/unit/mcp-stdio.test.mjs`)
Spawns the **real built `reversee-mcp` bridge** and speaks MCP JSON-RPC over stdio against the real control server — the exact path Claude Code / Cursor use. Verifies the bridge advertises the **app's** catalog (including a tool the bridge never shipped with — proving the dynamic catalog), forwards calls, carries the version advisory, and falls back gracefully when the app is down.

### Packaged smoke (`tests/smoke/packaged.spec.ts`)
Drives the **final signed, notarized app bundle** (not the dev build). It runs only in the release pipeline (`release.yml` → `verify-mac`), after the artifact is downloaded from the draft GitHub release and Gatekeeper-checked, because it needs the packaged binary. To run it by hand against a built app:

```sh
REVERSEE_APP_BIN="/path/to/Reversee.app/Contents/MacOS/Reversee" \
  npx playwright test -c playwright.smoke.config.ts
```

## Quick commands

```sh
npm test                              # unit + integration + MCP e2e (Vitest)
npm run typecheck                     # tsc (app + mcp)
npm run lint                          # eslint
npm run build && npx playwright test  # app end-to-end
```

## Adding tests

- **Proxy/core logic** → a Vitest file in `tests/unit/`; reuse the fixtures in `tests/unit/helpers.mjs`.
- **A new MCP tool** → add it to `src/main/mcp/catalog.ts` and a handler in `src/main/mcp/handlers.ts`; update the catalog assertion in `tests/unit/mcp-catalog.test.mjs`. The bridge needs no change (it serves whatever the app advertises).
- **A new user flow** → a Playwright spec in `tests/e2e/`; reuse `tests/e2e/fixtures/launch.ts`.
