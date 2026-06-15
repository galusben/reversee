# 0002 — The app owns the MCP tool catalog

Status: accepted

## Context

Agents reach the app through the `reversee-mcp` stdio bridge, distributed on npm and
typically run via `npx`. If the bridge hardcoded its tool list, every new or changed
tool would require republishing the bridge *and* every user clearing their npx cache
and reinstalling — so the app and the agent surface would drift, and shipping a tool
would be a two-package release.

## Decision

The **app owns the authoritative tool catalog** in
[`src/main/mcp/catalog.ts`](../../src/main/mcp/catalog.ts). The bridge fetches it at
startup (the `list_tools` control method) and registers exactly those tools. The
bridge keeps only a **frozen fallback copy** (`mcp/src/catalog.ts`) for when the app
is down. The catalog also derives the gated-mutation set (`MCP_MUTATING_METHODS`) and
carries a bridge-version advisory that nudges users off the pre-2.1.0 bridge (which
had a hardcoded list).

## Consequences

- Tools added in an app update reach agents automatically — no bridge republish, no
  npx cache dance.
- `catalog.ts` is the single source of truth for tool definitions *and* which tools
  are gated; the module is kept dependency-free so it can be unit-tested headlessly.
- Adding a tool = catalog entry + `handlers.ts` implementation + a catalog test
  assertion (see [TESTING.md](../../TESTING.md)).
