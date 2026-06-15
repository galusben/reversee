# Contributing to Reversee

Thanks for helping improve Reversee. This guide covers setup, the change workflow,
and where to look when you're stuck. For the deeper picture, read
[AGENTS.md](AGENTS.md) and the [knowledge base](docs/README.md).

## Setup

Requires Node.js (see `package.json` `engines` / `.nvmrc` if present).

```sh
npm install      # installs the root + the mcp/ workspace
npm start        # run the app in dev (electron-vite, HMR)
```

## Make a change

1. **Branch** off `main`.
2. Make your change. Use the code map in
   [docs/architecture.md](docs/architecture.md) to find the right files, including
   the "common change → files to touch" recipes.
3. **Add or update tests.** Pick the right layer per [TESTING.md](TESTING.md).
4. **Run the gates** before committing:
   ```sh
   npm run lint
   npm run typecheck
   npm test
   ```
   App end-to-end tests run with `npm run build` then `npx playwright test`.
5. **Open a PR** to `main`. CI runs lint, typecheck, unit/integration + MCP e2e, and
   Playwright e2e (macOS + Windows); they must pass.

## Conventions to know

- Keep the proxy core (`src/proxy/core/`) **Electron-free** — it's ESLint-enforced.
- Define new MCP tools in `src/main/mcp/catalog.ts` (single source of truth), then
  implement them in `handlers.ts`.
- Expose new renderer capabilities through the preload `RevAPI` allowlist, never raw
  `ipcRenderer`.
- Never commit secrets or certificates.

Full list: [docs/conventions.md](docs/conventions.md). The rationale behind the big
decisions: [docs/adr/](docs/adr/README.md).

## Releases

You don't publish by hand — releases are tag-driven. Maintainers cut a `v*` tag and
a gated pipeline takes over. See [RELEASING.md](RELEASING.md).
