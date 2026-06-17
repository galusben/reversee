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

## Every change goes through a pull request

**`main` is protected — you cannot push to it directly.** A direct push is rejected
("Changes must be made through a pull request"). All work lands via a PR whose
required status checks pass and which is merged through GitHub. This applies to
everyone, including maintainers; it's also why agents working in this repo branch and
open a PR rather than committing to `main`.

1. **Branch** off `main` (or use a git worktree).
2. Make your change. Use the code map in
   [docs/architecture.md](docs/architecture.md) to find the right files, including
   the "common change → files to touch" recipes.
3. **Add or update tests.** Pick the right layer per [TESTING.md](TESTING.md).
4. **Run the gates** before pushing:
   ```sh
   npm run lint
   npm run typecheck
   npm test
   ```
   App end-to-end tests run with `npm run build` then `npx playwright test`.
5. **Open a PR** to `main` and push your branch. CI runs lint, typecheck,
   unit/integration + MCP e2e, Playwright e2e (macOS + Windows), and a packaged build
   on all three OSes. **All required checks must pass before the PR can be merged** —
   the branch is configured to block merges otherwise. Squash-merge keeps history
   one-commit-per-PR (the repo's `(#NN)` convention).

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
