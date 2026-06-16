# Reversee

**[reversee website &amp; docs →](https://galusben.github.io/reversee/)** · Open source (MIT) · [Releases](https://github.com/galusben/reversee/releases/latest)

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
brew tap galusben/reversee
brew install --cask reversee
```

If Homebrew reports the tap is untrusted, run `brew trust galusben/reversee` once and re-run the install.

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
| `list_traffic` | Captured requests (newest last), bodies elided |
| `search_traffic` | Filter requests server-side (method, status, URL/regex, content-type, header, body, timing, errors) — fetch only what matters |
| `summarize_session` | Aggregate view: status classes, methods, content types, top hosts, errors, slowest |
| `get_traffic_entry` | One request in full: headers, bodies, timings, curl, upstream target, and decoded JWTs |
| `replay_request` | Re-send a captured request with optional edits (method/url/headers/body) to test a hypothesis |
| `set_interceptor` | Install request/response interceptor JS for mocking or fault injection |
| `decode_jwt` | Decode a JWT's header and claims (inspection only) |
| `list_breakpoints` | The configured breakpoint rules |
| `validate_setup` | Setup checks (destination, ports, root cert, proxy process) |
| `export_diagnostics` | Versions, platform, settings, state — for bug reports |

`replay_request`, `set_interceptor`, `update_config`, and the start/stop/restart tools are gated behind *Allow MCP to Control the Proxy* (or `--allow-mcp-control` headless); the rest are always available read-only.

The app owns this list — it serves the catalog to the bridge at startup, so **tools added in an app update appear automatically** with no MCP-server reinstall (the bridge is a generic passthrough). When the app is not running, the bridge advertises a built-in fallback list and each call returns a "launch Reversee" message.

### Updating the MCP server

You rarely need to — new tools arrive via app updates (the app owns the catalog). If the app does report a newer `reversee-mcp` is recommended (in `get_status`), restart your MCP client; on **npm 11.2+** that pulls the latest automatically.

On **older npm** (including npm 10.x bundled with Node 22 LTS), `npx` caches the server and won't re-fetch a newer version — [a known npm behavior](https://github.com/npm/cli/pull/8100). Clear Reversee's cached copy once, then restart:

```sh
for d in ~/.npm/_npx/*/; do [ -e "$d/node_modules/reversee-mcp" ] && rm -rf "$d"; done
```

This touches only Reversee's `npx` cache; the next run pulls the latest published version.

### Security model

- The bridge talks to the app over a **local socket** (unix domain socket / Windows named pipe), never a TCP port, with a per-boot token — only your user account can reach it.
- It is **read-only by default**. `start_proxy`, `stop_proxy`, `restart_proxy`, and `update_config` are rejected until you check *Proxy Settings → Allow MCP to Control the Proxy* in the app.
- *Proxy Settings → Enable MCP Integration* turns the socket off entirely.

### Headless mode (for agents)

An agent that only needs the proxy can run Reversee without the UI. The Homebrew cask puts `reversee` on `PATH`:

```sh
# isolate the agent's instance with its own profile + socket, allow it to control the proxy
REVERSEE_USER_DATA="$(mktemp -d)" reversee --headless --allow-mcp-control &
```

Then point the MCP client at the same profile (`REVERSEE_USER_DATA`) and drive it. Flags:

- `--headless` — no window/dock; runs on the MCP socket until killed. Implies MCP enabled.
- `--allow-mcp-control` — the launch-time equivalent of *Allow MCP to Control the Proxy* (start/stop/configure).
- `--no-mcp` / `--allow-mcp` — force the socket off / on.

Flags are session overrides and never change your saved settings. Using a separate `REVERSEE_USER_DATA` lets a headless agent instance coexist with your GUI instance (each gets its own control socket). On Linux a display is still required — wrap with `xvfb-run`.

## Development

Requirements: Node 22+.

```sh
npm install
npm start            # run the app (electron-vite dev, HMR)
npm test             # unit + integration + MCP e2e (vitest)
npm run typecheck    # tsc
npm run lint         # eslint
npm run build && npx playwright test   # app end-to-end tests
npm run dist         # build installers for this platform
```

Layout: `src/main` (Electron main process), `src/preload` (the typed renderer bridge), `src/renderer` (React UI), `src/proxy` (the proxy core — plain Node, runs in a utilityProcess), `src/shared` (types, IPC contracts, settings schema), `mcp/` (the `reversee-mcp` npm package).

New here? The [knowledge base](docs/README.md) is the fast way in: a code map ([docs/architecture.md](docs/architecture.md)), the human + agent feature catalog ([docs/features.md](docs/features.md)), conventions, and architecture decisions. See [CONTRIBUTING.md](CONTRIBUTING.md) to make a change and [AGENTS.md](AGENTS.md) for agent guidance.

Testing is documented in [TESTING.md](TESTING.md) (the four layers and how they map to CI); releases in [RELEASING.md](RELEASING.md).

Releases: push a `v*` tag; CI builds, signs, notarizes, verifies, and publishes macOS/Windows/Linux artifacts, then updates Homebrew. See [RELEASING.md](RELEASING.md).

## License

MIT
