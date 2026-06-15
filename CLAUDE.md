# Reversee — Claude Code notes

Agent guidance lives in **[AGENTS.md](AGENTS.md)** (commands, the code map,
working agreements, and how to drive the app over MCP). Read that first — it is
the canonical entry point, and the deeper knowledge base is in
[`docs/`](docs/README.md).

## Claude-specific notes

- `.claude/settings.local.json` holds a permission allowlist that pre-approves the
  common commands for this repo (`npm run *`, the `/tmp/reversee-mcp-live` MCP
  smoke-test setup, and Node module evaluation) so you hit fewer prompts.
- When driving the running app over MCP, mutating tools require the user to enable
  "Allow MCP to Control the Proxy" in the app (or `--allow-mcp-control` headless).
  See [docs/features.md](docs/features.md).
