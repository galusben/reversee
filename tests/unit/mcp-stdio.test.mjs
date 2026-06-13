// End-to-end test of the reversee-mcp bridge as a real spawned process:
// drives the built bridge over MCP stdio (JSON-RPC) against the real control
// server, exercising the full path an MCP client uses.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startControlServer } from '../../src/main/mcp/control-server';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridgeEntry = path.join(repoRoot, 'mcp', 'dist', 'cli.js');

beforeAll(() => {
  // The e2e drives the built bridge binary, so ensure it is current.
  execSync('npm run build -w reversee-mcp', { cwd: repoRoot, stdio: 'ignore' });
}, 120_000);

/** Spawns the bridge and speaks newline-delimited JSON-RPC over stdio. */
function spawnBridge(userDataDir) {
  const proc = spawn(process.execPath, [bridgeEntry], {
    env: { ...process.env, REVERSEE_USER_DATA: userDataDir },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (id, method, params) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { proc, rpc, kill: () => proc.kill() };
}

let bridge;
let server;
let dir;

afterEach(async () => {
  bridge?.kill();
  await server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  bridge = undefined;
  server = undefined;
  dir = undefined;
});

async function init(b) {
  await b.rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  b.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

describe('reversee-mcp bridge over stdio', () => {
  it('advertises the app catalog and forwards a call when the app is up', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-stdio-'));
    server = await startControlServer({
      dir,
      appVersion: '9.9.9-test',
      isControlAllowed: () => false,
      mutatingMethods: new Set(),
      handlers: {
        list_tools: () => ({
          tools: [
            { name: 'get_status', description: 'status', inputSchema: { type: 'object' } },
            { name: 'demo_new_tool', description: 'a tool the bridge never shipped with', inputSchema: { type: 'object' } },
          ],
          recommendedBridge: '2.0.0',
        }),
        get_status: () => ({ running: false, appVersion: '9.9.9-test' }),
      },
    });

    bridge = spawnBridge(dir);
    await init(bridge);

    const list = await bridge.rpc(2, 'tools/list');
    const names = list.result.tools.map((t) => t.name);
    // A tool defined only by the app is exposed through the unchanged bridge.
    expect(names).toContain('demo_new_tool');
    expect(names).toContain('get_status');

    const call = await bridge.rpc(3, 'tools/call', { name: 'get_status', arguments: {} });
    const status = JSON.parse(call.result.content[0].text);
    expect(status.appVersion).toBe('9.9.9-test');
    expect(status.bridge.upToDate).toBe(true); // bridge 2.0.0 == recommended
  });

  it('serves the fallback catalog and errors gracefully when the app is down', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-stdio-down-'));
    bridge = spawnBridge(dir);
    await init(bridge);

    const list = await bridge.rpc(2, 'tools/list');
    // Fallback catalog is the full known set.
    expect(list.result.tools.length).toBeGreaterThanOrEqual(11);

    const call = await bridge.rpc(3, 'tools/call', { name: 'get_status', arguments: {} });
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toMatch(/not running/i);
  });
});
