#!/usr/bin/env node
// reversee-mcp: stdio MCP server bridging Claude Code / Cursor to a running
// Reversee app over its local control socket.
//
//   claude mcp add reversee -- npx -y reversee-mcp
//
// The bridge is a generic proxy: the app owns the tool catalog (fetched at
// startup via `list_tools`), so new tools shipped in an app update reach users
// through their already-installed bridge. A frozen embedded catalog is used
// only when the app is not running.
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ReverseeClient } from './client.js';
import { resolveCatalog, versionAdvisory } from './catalog.js';

const BRIDGE_VERSION: string = createRequire(import.meta.url)('../package.json').version;

const client = new ReverseeClient();

// Snapshot the catalog at startup: if the app is up we advertise its tools, if
// not we advertise the frozen fallback. (A running app launched later is picked
// up on the next MCP client restart.)
const catalog = await resolveCatalog(client);

const server = new Server(
  { name: 'reversee', version: BRIDGE_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: catalog.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    // update_config takes its payload under `patch`; everything else forwards
    // its arguments object straight through as the method params.
    const params = name === 'update_config' ? (args?.['patch'] ?? {}) : args;
    const result = await client.call(name, params);

    // Surface an upgrade hint on get_status when the bridge is behind the
    // version the running app recommends.
    const payload =
      name === 'get_status' && result && typeof result === 'object'
        ? { ...(result as object), bridge: versionAdvisory(BRIDGE_VERSION, catalog.recommendedBridge) }
        : result;

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
