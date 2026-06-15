# 0003 — Gated MCP mutations over a local socket

Status: accepted

## Context

Letting an agent drive a reverse proxy is powerful and dangerous: changing the
destination, rewriting traffic, or starting/stopping the proxy can redirect or
expose a user's requests. The bridge runs on the user's machine alongside other
local software. The transport and authority model must make read-only inspection
easy while keeping state changes deliberate and local.

## Decision

- The bridge talks to the app over a **local Unix socket / Windows named pipe
  (mode 0600), never a TCP port**, authenticated with a **per-boot token file**
  (also 0600). See `src/main/mcp/control-server.ts`.
- **Read-only tools are always available.** **Mutating tools are gated**: rejected
  unless the user enables "Allow MCP to Control the Proxy" in the app, or launches
  headless with `--allow-mcp-control`. The gated set is derived from the catalog
  (`mutating: true`), so it can't fall out of sync — see
  [ADR 0002](0002-app-owns-mcp-tool-catalog.md).

## Consequences

- No network listener is exposed; only local processes with the token can connect.
- Agents can always inspect (status, config, traffic, breakpoints, diagnostics)
  without a prompt, but changing state requires an explicit human/CI opt-in.
- New mutating tools must be marked `mutating: true` in the catalog so they're gated
  by default.
