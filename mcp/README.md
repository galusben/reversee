# reversee-mcp

MCP server for [Reversee](https://github.com/galusben/reversee), the reverse-proxy web debugger. Lets MCP clients like Claude Code and Cursor inspect and (optionally) control a running Reversee app: read captured HTTP traffic, check and change the proxy configuration, and start/stop the proxy.

## Setup

Launch the Reversee app, then:

**Claude Code**

```sh
claude mcp add reversee -- npx -y reversee-mcp
```

**Cursor** — add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "reversee": { "command": "npx", "args": ["-y", "reversee-mcp"] }
  }
}
```

## Tools

| Tool | Description |
| --- | --- |
| `get_status` | App version, proxy state, listen/destination config, traffic count |
| `get_config` | Read the proxy configuration |
| `update_config` | Change the configuration (gated, see below) |
| `start_proxy` / `stop_proxy` / `restart_proxy` | Control the proxy (gated) |
| `list_traffic` | Captured requests, paged, bodies elided |
| `get_traffic_entry` | One request in full: headers, bodies, timings, curl command (decoded gRPC included) |
| `list_breakpoints` | Configured breakpoint rules |
| `list_proto_specs` | Saved protobuf specs used to decode gRPC, plus compile errors |
| `add_proto_spec` / `remove_proto_spec` | Save (`.proto` text or base64 FileDescriptorSet) / delete a protobuf spec (gated) |
| `validate_setup` | Setup checks: destination, ports, root cert, proxy process |
| `export_diagnostics` | Versions, platform, settings, state — for bug reports |

The Reversee app owns this list and serves it to the bridge at startup, so tools added in an app update appear automatically — this package rarely needs updating. When the app is not running, a built-in fallback list is advertised.

## Updating

You rarely need to — new tools arrive via Reversee app updates. If `get_status` reports a newer version is recommended, restart your MCP client; on **npm 11.2+** that fetches the latest.

On **older npm** (e.g. npm 10.x with Node 22 LTS), `npx` reuses the cached copy ([known npm behavior](https://github.com/npm/cli/pull/8100)) — clear it once, then restart:

```sh
for d in ~/.npm/_npx/*/; do [ -e "$d/node_modules/reversee-mcp" ] && rm -rf "$d"; done
```

## Security model

- The bridge talks to the app over a **local unix domain socket / Windows named pipe** with a per-boot token — never a TCP port. Only your user account can reach it.
- **Read-only by default.** The mutating tools (`start_proxy`, `stop_proxy`, `restart_proxy`, `update_config`, `add_proto_spec`, `remove_proto_spec`) are rejected until you check *Proxy Settings → Allow MCP to Control the Proxy* in the Reversee app.
- *Proxy Settings → Enable MCP Integration* in the app turns the socket off entirely.

If Reversee is not running, every tool returns a clear "launch the app" message.

## Requirements

- Node 20+
- Reversee 2.0+ running locally

## License

MIT
