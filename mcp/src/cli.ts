#!/usr/bin/env node
// reversee-mcp: stdio MCP server bridging Claude Code / Cursor to a running
// Reversee app over its local control socket.
//
// One-line setup:   claude mcp add reversee -- npx -y reversee-mcp
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ReverseeClient } from './client.js';

const client = new ReverseeClient();
const server = new McpServer({ name: 'reversee', version: '2.0.0' });

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function call(method: string, params?: unknown): Promise<ToolResult> {
  try {
    const result = await client.call(method, params);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
  }
}

server.registerTool(
  'get_status',
  {
    description:
      'Current Reversee state: app version, whether the proxy is running, listen/destination config, traffic and breakpoint counts.',
  },
  () => call('get_status')
);

server.registerTool(
  'get_config',
  { description: 'Full Reversee proxy configuration (listen/destination, interceptors, rewrite flags).' },
  () => call('get_config')
);

server.registerTool(
  'update_config',
  {
    description:
      'Update Reversee configuration. Accepts a partial settings object; unknown keys and invalid values are ignored. ' +
      'Keys: listenProtocol/destProtocol (http|https), listenPort/destPort (1-65535), dest (host), ' +
      'interceptRequest/interceptResponse (bool), requestInterceptor/responseInterceptor (JS source), ' +
      'rewriteRedirects/rewriteHost/allowSelfSignedUpstream (bool). ' +
      'Requires "Allow MCP to Control the Proxy" enabled in the app. Returns the resulting config.',
    inputSchema: { patch: z.record(z.string(), z.unknown()).describe('Partial settings object') },
  },
  ({ patch }) => call('update_config', patch)
);

server.registerTool(
  'start_proxy',
  {
    description:
      'Start the reverse proxy with the current configuration. Requires control to be enabled in the app.',
  },
  () => call('start_proxy')
);

server.registerTool(
  'stop_proxy',
  { description: 'Stop the reverse proxy. Requires control to be enabled in the app.' },
  () => call('stop_proxy')
);

server.registerTool(
  'restart_proxy',
  {
    description:
      'Restart the proxy worker process (also recovers from a wedged interceptor). Requires control to be enabled in the app.',
  },
  () => call('restart_proxy')
);

server.registerTool(
  'list_traffic',
  {
    description:
      'List captured requests (newest last): method, URL, status, content type, total time. Bodies are elided; use get_traffic_entry for full details.',
    inputSchema: {
      offset: z.number().int().min(0).optional().describe('Skip this many entries'),
      limit: z.number().int().min(1).max(200).optional().describe('Max entries to return (default 50)'),
    },
  },
  ({ offset, limit }) => call('list_traffic', { offset, limit })
);

server.registerTool(
  'get_traffic_entry',
  {
    description:
      'Full details of one captured request: headers, bodies, timings, and a copy-pasteable curl command.',
    inputSchema: { trafficId: z.number().int().describe('Id from list_traffic') },
  },
  ({ trafficId }) => call('get_traffic_entry', { trafficId })
);

server.registerTool(
  'list_breakpoints',
  { description: 'List the configured breakpoint rules (URL regex + HTTP methods).' },
  () => call('list_breakpoints')
);

server.registerTool(
  'validate_setup',
  {
    description:
      'Run setup checks: destination configured, ports valid, root certificate present, proxy process state.',
  },
  () => call('validate_setup')
);

server.registerTool(
  'export_diagnostics',
  {
    description:
      'Export diagnostics: versions, platform, full settings, proxy state, traffic count, breakpoints, log location.',
  },
  () => call('export_diagnostics')
);

await server.connect(new StdioServerTransport());
