# Testing

Reversee has four test layers. All of them except the packaged smoke test run on every PR.

| Layer              | Tool                       | Location                        | Run locally                            | Runs in CI                       |
| ------------------ | -------------------------- | ------------------------------- | -------------------------------------- | -------------------------------- |
| Unit & integration | Vitest                     | `tests/unit/**/*.test.*`        | `npm test`                             | `checks` job (every push/PR)     |
| App end-to-end     | Playwright (Electron)      | `tests/e2e/*.spec.ts`           | `npm run build && npx playwright test` | `e2e` (macOS) + `e2e-windows`    |
| MCP end-to-end     | Vitest (spawns the bridge) | `tests/unit/mcp-stdio.test.mjs` | `npm test`                             | `checks` job                     |
| Packaged smoke     | Playwright                 | `tests/smoke/packaged.spec.ts`  | (see below)                            | **Release only** (tag-triggered) |

`npm test` runs Vitest, which includes both the unit/integration suite and the MCP end-to-end (the latter builds and spawns the real bridge in `beforeAll`). `npm run lint` and `npm run typecheck` round out the `checks` job.

## What each layer covers

### Unit & integration (`tests/unit/`)

- **Proxy core** (`proxy.core`, `interceptor`, `curl`, `breakpoints`) — the request-forwarding logic, run headlessly against real `http`/`https` fixture servers (no Electron). This is the safety net the whole refactor was built on.
- **Traffic store** (`traffic-store`) — ring-buffer cap, eviction, body truncation.
- **gRPC** (`grpc-frames`, `grpc-registry`, `proto-store`, `grpc-proxy`) — length-prefixed framing (multi-frame, compression, truncation, incremental accumulator), proto-spec CRUD on disk, `.proto`/`.desc` compilation + method-map building, registry resolution, and a full round-trip through `createHttp2ProxyServer` against a hand-rolled h2c gRPC upstream (unary, server-streaming, and a non-OK Trailers-Only status — asserting decoded JSON both ways, the captured grpc-status, and raw passthrough). All headless (protobufjs and `node:http2` are dependency-light).
- **MCP** — `control-server` (token handshake, gating, permissions), `mcp-catalog` (the app-owned tool catalog + derived mutating set, and the bridge-version invariant — the app must never recommend a `reversee-mcp` newer than `mcp/package.json`; the registry half of that check is `npm run check:bridge-version`), `mcp-bridge` (`resolveCatalog` against the real control server incl. offline fallback, version-advisory logic), `mcp-client` (the bridge's socket client against the real server), `mcp-handlers` (every tool handler against the real traffic/proto/settings stores and a live replay upstream — only `ProxyHost` is faked).
- **Main-process modules** — `settings-schema` (sanitization is the single gate for every settings write), `settings` (electron-store layout incl. the legacy `root.cert.pem` key existing installs depend on, legacy migration, reset), `certs` (root CA + localhost leaf via node-forge, reuse across boots, and a real TLS handshake trusting only the root), `replay` (overrides, content-encoding decode, upstream-down, self-signed handling). Electron and electron-store are replaced with `vi.mock` stand-ins.
- **Preload contract** (`preload-api`) — exactly one global, exactly the `RevAPI` methods, each wired to its `IPC.*` channel, and every renderer-facing channel covered.
- **Renderer** (`tests/unit/renderer/`, jsdom) — `app` (the whole `<App/>` against a fake bridge: startup wiring, every main→renderer event), `settings-bar`, `detail-panes` (Radix tabs, body/headers/timings, JWT and gRPC panes, copy actions), `dialogs` (the shared Radix open/Escape/close/focus contract plus each dialog's actions), `traffic-panels` (table filter/selection/context menu, held-request editor, interceptor editors), and the stores. `fake-api.tsx` provides the fake `window.reversee`, store resets, the jsdom shims Radix needs, and a stand-in for the lazily loaded Monaco editor (Monaco itself is covered in e2e).

### App end-to-end (`tests/e2e/`)

Playwright drives the built app (`out/`) through real user flows: launch + sandbox assertions, configure/start/proxy/inspect, request & response interceptors, breakpoint hold→edit→resume, invalid-port handling, settings persistence across relaunch, HTTPS listening, and EADDRINUSE surfacing. `grpc.spec.ts` enables gRPC, seeds a proto spec, drives a real h2c gRPC call (unary + server-streaming) through the running app, and asserts the decoded messages and grpc-status in the UI — and with `CAPTURE_SCREENSHOTS=1` it regenerates the gRPC docs screenshots (`docs/screenshots/grpc-*.png`). The other specs cover what the main process and Chromium own:

- `security.spec.ts` — webPreferences (sandbox, context isolation, no node integration), the exact preload surface, the CSP (policy and enforcement), and the `window.open`/navigation lockdown with the external-link allowlist.
- `editor-clipboard.spec.ts` — the bundled Monaco editor (JSON language worker under the CSP, formatting, editing an interceptor), and every copy action read back from the system clipboard in main. It also records a known bug with `test.fail()`: the first "Formatted" click in a session doesn't format, because format-on-mount runs before Monaco lazily registers the JSON formatter.
- `app-lifecycle.spec.ts` — window bounds persisting across relaunch, menu checkboxes ↔ settings sync, Reset Cache, menu → dialog wiring, and the single-instance lock.
- `headless.spec.ts` — `--headless` driven purely through the MCP control socket with the bridge's own client: configure, start, proxy, inspect, replay, stop; and read-only without `--allow-mcp-control`.

Every spec that launches the GUI fails a test on any renderer `console.error` or uncaught exception (`rendererErrors` in `fixtures/launch.ts`). Note that the clipboard spec overwrites your system clipboard when run locally. Needs `npm run build` first.

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
- **A renderer component** → a jsdom test in `tests/unit/renderer/`; call `installFakeApi()`/`resetStores()` from `fake-api.tsx` and mock `MonacoViewImpl` with its `FakeMonaco`.
- **A new IPC channel** → add it to `src/shared/ipc.ts` and the preload, then to the tables in `tests/unit/preload-api.test.mjs` and `EXPECTED_API` in `tests/e2e/security.spec.ts` (both fail until you do).
