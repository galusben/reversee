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
import { resolveCatalog } from './catalog.js';

const BRIDGE_VERSION: string = createRequire(import.meta.url)('../package.json').version;

// The version is reported in the handshake; the app emits any upgrade advisory
// (in get_status) so the signal reaches even older bridges.
const client = new ReverseeClient(undefined, BRIDGE_VERSION);

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
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
