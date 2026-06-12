# Reversee

A reverse-proxy web debugger: see, intercept, and edit HTTP/HTTPS traffic between a client and a server with the least setup possible.

Reversee sits between your client and a destination server. Point your client at Reversee's listen port and every request and response shows up in the traffic table — headers, bodies (with gzip/brotli decoding and syntax highlighting), timings, and a copy-as-curl command.

## Features

- **HTTP and HTTPS** on both sides — listen on either protocol, forward to either protocol. HTTPS listening uses a locally generated root CA you can trust once (macOS: *Proxy Settings → Manage Root Cert*).
- **Traffic inspection** — method, path, status, content type, headers, request/response bodies (plain and formatted), and per-request timings (DNS, TCP, TLS, first byte, total).
- **Interceptors** — JavaScript snippets that rewrite requests (`requestParams`: host, path, method, port, headers, body) or responses (`responseParams`: statusCode, headers, body) on the fly.
- **Breakpoints** — hold requests matching a URL regex + methods, edit the URL, headers, and body, then continue.
- **Redirect & host rewriting** — keep redirect chains and Host headers pointed at the proxy.
- **MCP integration** — let Claude Code, Cursor, or any MCP client inspect and (optionally) control the proxy. See below.

## Install

**macOS (Homebrew):**

```sh
brew install --cask galusben/reversee/reversee
```

**macOS / Linux (one-liner):**

```sh
curl -fsSL https://raw.githubusercontent.com/galusben/reversee/main/install.sh | bash
```

**Windows / manual:** download the installer for your OS from [Releases](https://github.com/galusben/reversee/releases).

macOS builds are signed and notarized; the app updates itself from GitHub Releases.

## Getting started

1. Install and launch Reversee.
2. Pick a listen protocol and port (ports below 1024 need admin/root).
3. Pick the destination protocol, host, and port.
4. Click **Start**.

Test it:

```sh
curl http://localhost:<listen-port>/
```

The request appears in the traffic table; click it to inspect.

## MCP integration (Claude Code / Cursor)

Reversee ships an MCP server so LLM agents can drive it. With the Reversee app running:

**Claude Code** — one line:

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

The package is published as [`reversee-mcp`](https://www.npmjs.com/package/reversee-mcp). When developing against a checkout, use the local build instead: `npm run build:mcp`, then `claude mcp add reversee -- node /path/to/reversee/mcp/dist/cli.js`.

### Tools

| Tool | Description |
| --- | --- |
| `get_status` | App version, proxy state, listen/destination config, traffic count |
| `get_config` / `update_config` | Read / change the proxy configuration |
| `start_proxy` / `stop_proxy` / `restart_proxy` | Control the proxy process |
| `list_traffic` / `get_traffic_entry` | Browse captured requests; full headers, bodies, timings, curl |
| `list_breakpoints` | The configured breakpoint rules |
| `validate_setup` | Setup checks (destination, ports, root cert, proxy process) |
| `export_diagnostics` | Versions, platform, settings, state — for bug reports |

### Security model

- The bridge talks to the app over a **local socket** (unix domain socket / Windows named pipe), never a TCP port, with a per-boot token — only your user account can reach it.
- It is **read-only by default**. `start_proxy`, `stop_proxy`, `restart_proxy`, and `update_config` are rejected until you check *Proxy Settings → Allow MCP to Control the Proxy* in the app.
- *Proxy Settings → Enable MCP Integration* turns the socket off entirely.

## Development

Requirements: Node 22+.

```sh
npm install
npm start            # run the app (electron-vite dev, HMR)
npm test             # unit tests (vitest)
npm run typecheck    # tsc
npm run lint         # eslint
npm run build && npx playwright test   # end-to-end tests
npm run dist         # build installers for this platform
```

Layout: `src/main` (Electron main process), `src/preload` (the typed renderer bridge), `src/renderer` (React UI), `src/proxy` (the proxy core — plain Node, runs in a utilityProcess), `src/shared` (types, IPC contracts, settings schema), `mcp/` (the `reversee-mcp` npm package).

Releases: push a `v*` tag; CI builds and publishes macOS/Windows/Linux artifacts to GitHub Releases, and the app auto-updates from there.

## License

MIT
