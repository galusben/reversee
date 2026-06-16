# 0005 — Deferred decisions

Status: open

## Context

Some decisions surfaced during the project's modernization but were deliberately
**deferred** rather than decided. Recording them keeps the open questions visible so
they're picked up intentionally instead of rediscovered, and so a contributor doesn't
assume the current behavior is a settled choice.

## Open questions

- **S3 → GitHub user migration.** The legacy update/download channel used S3; the
  current pipeline publishes to GitHub Releases (see
  [ADR 0004](0004-tag-driven-release-pipeline.md) and the "Legacy S3 channel" note in
  [RELEASING.md](../../RELEASING.md)). How (and whether) to migrate existing users off
  the S3 channel is undecided.
- **Code signing breadth.** macOS is signed + notarized in CI; the policy for signing
  Windows (and whether to invest in it) is not yet settled.
- **MCP on by default.** Today MCP control is opt-in (mutations gated — see
  [ADR 0003](0003-gated-mcp-mutations-over-local-socket.md)). Whether the MCP server
  should be enabled by default, and under what safeguards, is open.

## Consequences

- These are not commitments — treat the current behavior as the status quo, not a
  decided position.
- When one is resolved, add a new numbered ADR that decides it and update this file
  to point at it.
