// The MCP tool handlers (src/main/mcp/handlers.ts), exercised with the real
// TrafficStore, ProtoStore, settings module (over an in-memory electron-store)
// and replay path. Only ProxyHost is faked — it owns a utilityProcess. The
// control-server tests cover transport and gating; this covers what each tool
// actually does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startUpstream, closeAll } from './helpers.mjs';

const backing = new Map();
vi.mock('electron-store', () => ({
  default: class FakeStore {
    get(key) {
      return backing.get(key);
    }
    set(key, value) {
      backing.set(key, structuredClone(value));
    }
    has(key) {
      return backing.has(key);
    }
    delete(key) {
      backing.delete(key);
    }
  },
}));
vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9-test', getPath: () => '/tmp/reversee-logs' },
}));

const { createMcpHandlers, MCP_MUTATING_METHODS } = await import('../../src/main/mcp/handlers');
const { MCP_TOOL_CATALOG } = await import('../../src/main/mcp/catalog');
const { TrafficStore } = await import('../../src/main/traffic-store');
const { ProtoStore } = await import('../../src/main/proto/proto-store');
const { setSettings, setRootCertPem } = await import('../../src/main/settings');

const PROTO = `syntax = "proto3";
package demo;
message Ping { string text = 1; }
service Echo { rpc Say (Ping) returns (Ping); }`;

let ctx;
let handlers;
let protoDir;
let upstream;
const conn = { bridgeVersion: undefined };

function entry({
  method = 'GET',
  url = '/',
  status = 200,
  contentType,
  body,
  target,
  ...rest
} = {}) {
  return {
    trafficId: 0,
    request: { method, url, headers: {}, target },
    response: {
      statusCode: status,
      headers: contentType ? { 'content-type': contentType } : {},
      body: body === undefined ? undefined : Buffer.from(body),
    },
    timings: { start: new Date().toISOString(), total: 5_000_000 },
    ...rest,
  };
}

beforeEach(() => {
  backing.clear();
  protoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-handlers-'));
  const trafficStore = new TrafficStore();
  const protoStore = new ProtoStore(protoDir);
  ctx = {
    proxyHost: {
      isRunning: false,
      stop: vi.fn(function () {
        ctx.proxyHost.isRunning = false;
      }),
      restart: vi.fn(() => Promise.resolve(8123)),
    },
    trafficStore,
    getBreakpointRules: () => [{ id: 'GET /x', path: '/x', methods: ['GET'] }],
    startProxy: vi.fn(() => Promise.resolve({ ok: true, port: 8000 })),
    protoStore,
    syncProtoSpecs: vi.fn(() => {
      const { errors } = protoStore.compile();
      return { specs: protoStore.list(), errors };
    }),
    recordTraffic: vi.fn((e) => trafficStore.add(e)),
  };
  handlers = createMcpHandlers(ctx);
});

afterEach(async () => {
  fs.rmSync(protoDir, { recursive: true, force: true });
  await closeAll(upstream?.server);
  upstream = undefined;
});

describe('catalog consistency', () => {
  it('has a handler for every tool the catalog advertises', () => {
    for (const tool of MCP_TOOL_CATALOG) expect(handlers).toHaveProperty(tool.name);
  });

  it('only marks real handlers as mutating', () => {
    for (const method of MCP_MUTATING_METHODS) expect(handlers).toHaveProperty(method);
  });
});

describe('status and config', () => {
  it('get_status reflects settings, proxy state, and store sizes', () => {
    setSettings({ dest: 'api.test', destProtocol: 'https', destPort: 8443, listenPort: 9001 });
    ctx.trafficStore.add(entry());
    const status = handlers.get_status({}, conn);
    expect(status).toMatchObject({
      appVersion: '9.9.9-test',
      running: false,
      listenPort: 9001,
      destination: 'https://api.test:8443',
      trafficCount: 1,
      breakpointCount: 1,
    });
    expect(status.bridge).toBeDefined();
  });

  it('update_config sanitizes and persists; get_config reads it back', () => {
    const next = handlers.update_config({ dest: 'x.test', listenPort: -1, bogus: true });
    expect(next.dest).toBe('x.test');
    expect(next).not.toHaveProperty('bogus');
    expect(handlers.get_config()).toEqual(next);
  });

  it('set_interceptor writes the right fields per kind and validates kind', () => {
    expect(handlers.set_interceptor({ kind: 'request', code: 'a', enabled: true })).toMatchObject({
      requestInterceptor: 'a',
      interceptRequest: true,
    });
    expect(handlers.set_interceptor({ kind: 'response', enabled: true })).toMatchObject({
      interceptResponse: true,
    });
    expect(() => handlers.set_interceptor({ kind: 'both' })).toThrow(/kind must be/);
  });
});

describe('proxy control', () => {
  it('start_proxy returns the port, and surfaces start failures as errors', async () => {
    await expect(handlers.start_proxy()).resolves.toEqual({ running: true, port: 8000 });
    ctx.startProxy.mockResolvedValueOnce({ ok: false, error: { message: 'EADDRINUSE' } });
    await expect(handlers.start_proxy()).rejects.toThrow('EADDRINUSE');
  });

  it('restart_proxy starts when stopped and restarts when running', async () => {
    await expect(handlers.restart_proxy()).resolves.toEqual({ running: true, port: 8000 });
    expect(ctx.proxyHost.restart).not.toHaveBeenCalled();
    ctx.proxyHost.isRunning = true;
    await expect(handlers.restart_proxy()).resolves.toEqual({ running: true, port: 8123 });
    expect(ctx.proxyHost.restart).toHaveBeenCalledOnce();
  });

  it('stop_proxy stops the host', () => {
    ctx.proxyHost.isRunning = true;
    expect(handlers.stop_proxy()).toEqual({ running: false });
    expect(ctx.proxyHost.stop).toHaveBeenCalledOnce();
  });
});

describe('traffic queries', () => {
  beforeEach(() => {
    for (let i = 0; i < 260; i++) ctx.trafficStore.add(entry({ url: `/item/${i}` }));
    ctx.trafficStore.add(entry({ method: 'POST', url: '/orders', status: 500 }));
  });

  it('list_traffic paginates and clamps the limit to 1..200', () => {
    const page = handlers.list_traffic({ offset: 10, limit: 5 });
    expect(page.total).toBe(261);
    expect(page.entries.map((e) => e.url)).toEqual([10, 11, 12, 13, 14].map((i) => `/item/${i}`));
    expect(handlers.list_traffic({ limit: 10_000 }).entries).toHaveLength(200);
    expect(handlers.list_traffic({ limit: 0 }).entries).toHaveLength(1);
    expect(handlers.list_traffic({ offset: -5 }).offset).toBe(0);
    expect(handlers.list_traffic().entries).toHaveLength(50);
  });

  it('list_traffic summaries carry the stable id and ms timings', () => {
    const [first] = handlers.list_traffic({ limit: 1 }).entries;
    expect(first).toMatchObject({ trafficId: 1, method: 'GET', statusCode: 200, totalMs: 5 });
  });

  it('search_traffic applies the filter keys and ignores bad types', () => {
    expect(handlers.search_traffic({ method: 'POST' }).matched).toBe(1);
    expect(handlers.search_traffic({ status: 500 }).entries[0].url).toBe('/orders');
    expect(handlers.search_traffic({ hasError: true }).matched).toBe(1);
    expect(handlers.search_traffic({ method: 42 }).matched).toBe(261);
  });

  it('summarize_session clamps the slowest count', () => {
    expect(handlers.summarize_session({ slowest: 500 }).slowest).toHaveLength(50);
    expect(handlers.summarize_session({}).total).toBe(261);
  });
});

describe('get_traffic_entry', () => {
  it('returns the full entry with bodies as text and decoded JWTs', () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'none' })}.${b64({ sub: 'u1' })}.sig`;
    const stored = ctx.trafficStore.add({
      ...entry({ contentType: 'application/json', body: '{"a":1}' }),
      request: { method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } },
    });
    const full = handlers.get_traffic_entry({ trafficId: stored.trafficId });
    expect(full.response.body).toBe('{"a":1}');
    expect(full.contentType).toBe('application/json');
    expect(full.decoded[0].jwt.payload).toEqual({ sub: 'u1' });
  });

  it('validates the id', () => {
    expect(() => handlers.get_traffic_entry({})).toThrow(/trafficId/);
    expect(() => handlers.get_traffic_entry({ trafficId: 999 })).toThrow(/no traffic entry/);
  });
});

describe('replay_request', () => {
  it('replays against the recorded target and records the result', async () => {
    upstream = await startUpstream((req, res) => res.end(`replayed ${req.method} ${req.url}`));
    const original = ctx.trafficStore.add(
      entry({ url: '/orig', target: { protocol: 'http', host: '127.0.0.1', port: upstream.port } })
    );
    const result = await handlers.replay_request({
      trafficId: original.trafficId,
      overrides: { method: 'DELETE', url: '/edited' },
    });
    expect(result.response.body).toBe('replayed DELETE /edited');
    expect(result.replay).toBe(true);
    expect(result.trafficId).not.toBe(original.trafficId);
    expect(ctx.recordTraffic).toHaveBeenCalledOnce();
    expect(ctx.trafficStore.size).toBe(2);
  });

  it('refuses entries without a recorded target', async () => {
    const stored = ctx.trafficStore.add(entry());
    await expect(handlers.replay_request({ trafficId: stored.trafficId })).rejects.toThrow(
      /no recorded upstream target/
    );
  });
});

describe('decode_jwt', () => {
  it('decodes well-formed tokens and rejects the rest', () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(
      handlers.decode_jwt({ token: `${b64({ alg: 'HS256' })}.${b64({ a: 1 })}.s` }).payload
    ).toEqual({ a: 1 });
    expect(() => handlers.decode_jwt({ token: 'nope' })).toThrow(/well-formed/);
    expect(() => handlers.decode_jwt({})).toThrow(/token/);
  });
});

describe('proto specs', () => {
  it('adds, lists, and removes a .proto spec, syncing the worker each time', () => {
    const added = handlers.add_proto_spec({ name: 'demo.proto', source: 'proto', content: PROTO });
    expect(added.errors).toEqual([]);
    expect(added.specs).toHaveLength(1);
    expect(handlers.list_proto_specs().specs[0].name).toBe('demo.proto');

    const removed = handlers.remove_proto_spec({ id: added.specs[0].id });
    expect(removed.specs).toEqual([]);
    expect(ctx.syncProtoSpecs).toHaveBeenCalledTimes(2);
  });

  it('reports compile errors instead of throwing', () => {
    const result = handlers.add_proto_spec({
      name: 'broken.proto',
      source: 'proto',
      content: 'message {',
    });
    expect(result.errors).toHaveLength(1);
  });

  it('validates arguments', () => {
    expect(() => handlers.add_proto_spec({ name: 'x', source: 'yaml', content: '' })).toThrow();
    expect(() => handlers.remove_proto_spec({})).toThrow(/id/);
  });
});

describe('validate_setup and diagnostics', () => {
  it('flags a missing destination and root CA', () => {
    const result = handlers.validate_setup();
    expect(result.ok).toBe(false);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c.ok]));
    expect(byName['destination-configured']).toBe(false);
    expect(byName['root-certificate']).toBe(false);
  });

  it('passes once configured', () => {
    setSettings({ dest: 'api.test' });
    setRootCertPem({ privateKey: 'k', publicKey: 'p', certificate: 'c' });
    expect(handlers.validate_setup().ok).toBe(true);
  });

  it('export_diagnostics includes runtime versions and settings', () => {
    const diag = handlers.export_diagnostics();
    expect(diag).toMatchObject({
      appVersion: '9.9.9-test',
      node: process.versions.node,
      proxyRunning: false,
      logFile: '/tmp/reversee-logs',
    });
    expect(diag.settings).toHaveProperty('listenPort');
  });
});
