// Integration test: the reversee-mcp bridge client against the real control
// server implementation (same code main runs), in a temp dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../../src/main/mcp/control-server';
import {
  ReverseeClient,
  ReverseeNotRunningError,
  ControlCallError,
} from '../../mcp/src/client';

let dir;
let server;
let controlAllowed = false;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-mcp-bridge-'));
  controlAllowed = false;
  server = await startControlServer({
    dir,
    appVersion: '0.0.0-test',
    isControlAllowed: () => controlAllowed,
    mutatingMethods: new Set(['start_proxy']),
    handlers: {
      get_status: () => ({ running: false, appVersion: '0.0.0-test' }),
      start_proxy: () => ({ running: true, port: 1234 }),
    },
  });
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reversee-mcp client', () => {
  it('performs the handshake and calls read-only methods', async () => {
    const client = new ReverseeClient(dir);
    const status = await client.call('get_status');
    expect(status).toEqual({ running: false, appVersion: '0.0.0-test' });
  });

  it('surfaces the control-disabled error for gated methods', async () => {
    const client = new ReverseeClient(dir);
    await expect(client.call('start_proxy')).rejects.toThrowError(ControlCallError);
    await expect(client.call('start_proxy')).rejects.toThrow(/Allow MCP to control/);
  });

  it('mutating methods work once control is allowed', async () => {
    controlAllowed = true;
    const client = new ReverseeClient(dir);
    expect(await client.call('start_proxy')).toEqual({ running: true, port: 1234 });
  });

  it('reports a friendly error when the app is not running', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-mcp-empty-'));
    const client = new ReverseeClient(emptyDir);
    await expect(() => client.call('get_status')).rejects.toThrowError(ReverseeNotRunningError);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('reports not-running when the token exists but the socket is gone', async () => {
    const client = new ReverseeClient(dir);
    await server.close();
    // Recreate the token file (close() removed it) without a listening socket.
    fs.writeFileSync(path.join(dir, 'mcp-token'), 'stale-token');
    await expect(client.call('get_status')).rejects.toThrowError(ReverseeNotRunningError);
    // afterEach close() is a no-op on an already-closed server.
    server = { close: async () => {} };
  });
});
