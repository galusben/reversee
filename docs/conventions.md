# Conventions

Process and code conventions for working in this repo. The full contribution
walkthrough is in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Quality gates

- **`npm run lint` and `npm run typecheck` must pass before committing** — both gate
  CI, on the app *and* the `mcp/` workspace.
- `npm run format` (prettier) keeps formatting consistent.

## Testing

Four layers — unit/integration + MCP e2e (Vitest, `tests/unit/`), app e2e
(Playwright, `tests/e2e/`), and packaged smoke (release-only, `tests/smoke/`). All
but the packaged smoke run on every PR. **Read [TESTING.md](../TESTING.md) before
adding or changing tests** — it says which layer a change belongs in and how the
layers map to CI jobs.

## Architecture rules

- **Keep the proxy core Electron-free.** `src/proxy/core/` is plain Node, enforced by
  ESLint, so it stays headless-testable —
  [ADR 0001](adr/0001-electron-free-proxy-core.md).
- **The app owns the MCP tool catalog.** New tools are defined in
  `src/main/mcp/catalog.ts` (the single source of truth for the bridge and the
  gated-mutation set), not in the bridge —
  [ADR 0002](adr/0002-app-owns-mcp-tool-catalog.md).
- **The preload is the only renderer bridge** — expose new capabilities through the
  `RevAPI` allowlist, never raw `ipcRenderer`.

## Releases

Releases are **tag-driven** — never hand-publish. A `v*` tag drives a gated pipeline
(build → verify-mac → promote → homebrew). See [RELEASING.md](../RELEASING.md) and
[ADR 0004](adr/0004-tag-driven-release-pipeline.md).

## Security

- macOS builds are signed + notarized in CI. **Never commit secrets or certificates.**
- The MCP control surface is local-socket + token-authenticated, with mutations
  gated — [ADR 0003](adr/0003-gated-mcp-mutations-over-local-socket.md).

## Related repositories and artifacts

| Artifact | Where | Notes |
| --- | --- | --- |
| App source (this repo) | `galusben/reversee` | The Electron app + the `mcp/` workspace. |
| Homebrew cask tap | `galusben/homebrew-reversee` | Auto-updated on stable releases by the release pipeline. |
| MCP bridge (npm) | `reversee-mcp` | <https://www.npmjs.com/package/reversee-mcp>. Built from `mcp/`. |
| Landing site | GitHub Pages from `docs/` | <https://galusben.github.io/reversee/>. |
| Homepage | reversee.ninja | Marketing site. |
| Releases | GitHub Releases | <https://github.com/galusben/reversee/releases>. |

License: MIT.
