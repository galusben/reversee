// Unit tests for the MCP control socket: handshake, gating, permissions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startControlServer,
  socketPathFor,
  tokenPathFor,
} from '../../src/main/mcp/control-server';

let dir;
let server;
let controlAllowed = false;

function connect() {
  const socket = net.connect(socketPathFor(dir));
  const lines = [];
  const waiters = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (waiters.length) waiters.shift()(line);
      else lines.push(line);
    }
  });
  const next = () =>
    new Promise((resolve) => {
      if (lines.length) resolve(lines.shift());
      else waiters.push(resolve);
    });
  const send = (msg) => socket.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({ socket, send, next }));
    socket.once('error', reject);
  });
}

async function authedClient() {
  const client = await connect();
  client.send({ token: fs.readFileSync(tokenPathFor(dir), 'utf8') });
  const hello = await client.next();
  expect(hello.ok).toBe(true);
  return client;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-mcp-test-'));
  controlAllowed = false;
  server = await startControlServer({
    dir,
    appVersion: '0.0.0-test',
    isControlAllowed: () => controlAllowed,
    mutatingMethods: new Set(['start_proxy', 'update_config']),
    handlers: {
      get_status: () => ({ running: false }),
      start_proxy: () => ({ started: true }),
      update_config: (params) => ({ updated: params }),
      boom: () => {
        throw new Error('handler exploded');
      },
    },
  });
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('control server', () => {
  it('rejects a bad token and closes the connection', async () => {
    const client = await connect();
    client.send({ token: 'wrong' });
    const reply = await client.next();
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad-token');
    await new Promise((resolve) => client.socket.once('close', resolve));
  });

  it('accepts the token from the token file and serves read-only methods', async () => {
    const client = await authedClient();
    client.send({ id: 1, method: 'get_status' });
    const reply = await client.next();
    expect(reply).toEqual({ id: 1, result: { running: false } });
    client.socket.destroy();
  });

  it('rejects mutating methods while control is disabled', async () => {
    const client = await authedClient();
    client.send({ id: 2, method: 'start_proxy' });
    const reply = await client.next();
    expect(reply.error.code).toBe('control-disabled');
    client.socket.destroy();
  });

  it('allows mutating methods when control is enabled', async () => {
    controlAllowed = true;
    const client = await authedClient();
    client.send({ id: 3, method: 'update_config', params: { dest: 'x' } });
    const reply = await client.next();
    expect(reply.result).toEqual({ updated: { dest: 'x' } });
    client.socket.destroy();
  });

  it('reports unknown methods and handler errors per-request', async () => {
    const client = await authedClient();
    client.send({ id: 4, method: 'nope' });
    expect((await client.next()).error.code).toBe('unknown-method');
    client.send({ id: 5, method: 'boom' });
    const boom = await client.next();
    expect(boom.error.code).toBe('handler-error');
    expect(boom.error.message).toBe('handler exploded');
    client.socket.destroy();
  });

  it.skipIf(process.platform === 'win32')('creates socket and token with 0600 permissions', () => {
    expect(fs.statSync(socketPathFor(dir)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(tokenPathFor(dir)).mode & 0o777).toBe(0o600);
  });

  it('requires authentication before any method call', async () => {
    const client = await connect();
    client.send({ id: 9, method: 'get_status' });
    const reply = await client.next();
    // Treated as a (failed) handshake, not a method call.
    expect(reply.ok).toBe(false);
    await new Promise((resolve) => client.socket.once('close', resolve));
  });
});
