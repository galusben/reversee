// The MCP tool handlers (src/main/mcp/handlers.ts), exercised with the real
// SessionManager (tabs), TrafficStore, ProtoStore, settings module (over an
// in-memory electron-store) and replay path. Only ProxyHost is faked — it owns
// a utilityProcess. The control-server tests cover transport and gating; this
// covers what each tool actually does.
import { tryScript } from '../../src/proxy/core/try-script';
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
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));

const { createMcpHandlers, MCP_MUTATING_METHODS } = await import('../../src/main/mcp/handlers');
const { MCP_TOOL_CATALOG } = await import('../../src/main/mcp/catalog');
const { ProtoStore } = await import('../../src/main/proto/proto-store');
const { setSettings } = await import('../../src/main/settings');
const { SessionManager } = await import('../../src/main/session-manager');

const PROTO = `syntax = "proto3";
package demo;
message Ping { string text = 1; }
service Echo { rpc Say (Ping) returns (Ping); }`;

let ctx;
let handlers;
let protoDir;
let upstream;
let sessions;
let certStatus;
const VALID_CERT = {
  notAfter: '2036-05-01T00:00:00.000Z',
  daysLeft: 3400,
  expired: false,
  expiringSoon: false,
};
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

/**
 * Stands in for ProxyHost (which owns a utilityProcess) and reports state
 * changes back to the session the way the real worker does.
 */
function fakeProxyHost(events) {
  const host = {
    events,
    isRunning: false,
    start: vi.fn(async () => {
      host.isRunning = true;
      events.onStateChanged(true, 8000);
      return 8000;
    }),
    stop: vi.fn(() => {
      host.isRunning = false;
      events.onStateChanged(false);
    }),
    restart: vi.fn(() => Promise.resolve(8123)),
    kill: vi.fn(),
    setBreakpoints: vi.fn(),
    setRules: vi.fn(),
    setScripts: vi.fn(),
    setProtoSpecs: vi.fn(),
    resumeBreakpoint: vi.fn(),
    // The real host runs this in the worker; the engine is the same.
    tryScript: vi.fn((input) => Promise.resolve(tryScript(input))),
  };
  return host;
}

const noEvents = {
  traffic() {},
  trafficCleared() {},
  state() {},
  error() {},
  breakpointHit() {},
  breakpointResumed() {},
  breakpointsChanged() {},
  breakpointErrors() {},
  tabsChanged() {},
};

/** The proxy of the active tab reports that it is running. */
function setRunning() {
  ctx.proxyHost.events.onStateChanged(true, 8000);
}

/** The active tab's worker holds an exchange; returns its (cross-tab) id. */
function hold(hit) {
  ctx.proxyHost.events.onBreakpointHit(hit);
  return sessions.active().heldHits.at(-1).id;
}

beforeEach(() => {
  backing.clear();
  protoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-handlers-'));
  const protoStore = new ProtoStore(protoDir);
  certStatus = undefined;
  const hosts = new Map();
  sessions = new SessionManager({
    getLeafCert: () => undefined,
    issueCert: () => {
      throw new Error('no CA in tests');
    },
    createProxyHost: (events) => {
      const host = fakeProxyHost(events);
      hosts.set(events, host);
      return host;
    },
    events: noEvents,
    summaryDelayMs: 0,
  });
  ctx = {
    sessions,
    getCertStatus: () => {
      if (!certStatus) throw new Error('no certificates');
      return certStatus;
    },
    regenerateRootCert: vi.fn(() => {
      certStatus = { ...VALID_CERT };
      return Promise.resolve(certStatus);
    }),
    protoStore,
    syncProtoSpecs: vi.fn(() => {
      const { errors } = protoStore.compile();
      return { specs: protoStore.list(), errors };
    }),
    // Test conveniences: the active tab's store and fake worker.
    get trafficStore() {
      return sessions.active().trafficStore;
    },
    get proxyHost() {
      return sessions.active().proxyHost;
    },
  };
  sessions.active().setBreakpointRules([{ id: 'GET /x', path: '/x', methods: ['GET'] }]);
  ctx.proxyHost.setBreakpoints.mockClear();
  handlers = createMcpHandlers(ctx);
});

afterEach(async () => {
  sessions.dispose();
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

  it('get_status reports capture-anything mode with the proxy address instead of a destination', () => {
    setSettings({ captureAll: true, listenPort: 9001 });
    const status = handlers.get_status({}, conn);
    expect(status).toMatchObject({ mode: 'capture-anything', proxyUrl: 'http://127.0.0.1:9001' });
    expect(status).not.toHaveProperty('destination');
    setSettings({ captureAll: false });
    expect(handlers.get_status({}, conn).mode).toBe('forward');
  });

  it('update_config sanitizes and persists; get_config reads it back', () => {
    const next = handlers.update_config({ dest: 'x.test', listenPort: -1, bogus: true });
    expect(next.dest).toBe('x.test');
    expect(next).not.toHaveProperty('bogus');
    expect(next.tab).toEqual({ id: 't1', name: 'x.test' });
    expect(handlers.get_config()).toEqual(next);
  });

  it('set_interceptor writes the right fields per kind and validates kind', () => {
    expect(handlers.set_interceptor({ kind: 'request', code: 'a', enabled: true })).toEqual({
      tab: { id: 't1', name: 'New tab' },
      kind: 'request',
      enabled: true,
      code: 'a',
      applied: 'saved; takes effect when the proxy starts (start_proxy)',
    });
    expect(handlers.get_config()).toMatchObject({
      requestInterceptor: 'a',
      interceptRequest: true,
    });
    setRunning();
    expect(handlers.set_interceptor({ kind: 'response', enabled: true })).toMatchObject({
      kind: 'response',
      enabled: true,
      applied: 'active now on the running proxy',
    });
    expect(handlers.get_config()).toMatchObject({ interceptResponse: true });
    expect(() => handlers.set_interceptor({ kind: 'both' })).toThrow(/kind must be/);
  });

  it('try_interceptor dry-runs code, or the saved script, against a captured exchange', async () => {
    const { trafficId } = ctx.trafficStore.add(
      entry({ url: '/a', body: 'hello', target: { protocol: 'http', host: 'up', port: 81 } })
    );
    const result = await handlers.try_interceptor({
      kind: 'response',
      trafficId,
      code: 'responseParams.statusCode = 503; console.log(requestParams.path)',
    });
    expect(result).toEqual({
      after: {
        request: { method: 'GET', path: '/a', host: 'up', port: 81, headers: {}, body: '' },
        response: { statusCode: 503, headers: {}, body: 'hello' },
      },
      changes: ['status: 200 → 503'],
      error: undefined,
      logs: ['/a'],
    });

    handlers.set_interceptor({ kind: 'request', code: "requestParams.path = '/b'" });
    expect((await handlers.try_interceptor({ kind: 'request', trafficId })).changes).toEqual([
      'path: /a → /b',
    ]);

    const failed = await handlers.try_interceptor({ kind: 'request', trafficId, code: 'nope()' });
    expect(failed.error).toBe('nope is not defined');
    expect(failed.changes).toEqual([]);

    await expect(handlers.try_interceptor({ kind: 'request', trafficId: 999 })).rejects.toThrow(
      /no longer in the list/
    );
    await expect(handlers.try_interceptor({ kind: 'both', trafficId })).rejects.toThrow(
      /kind must be/
    );
    await expect(handlers.try_interceptor({ kind: 'request' })).rejects.toThrow(/trafficId/);
  });
});

describe('proxy control', () => {
  beforeEach(() => {
    setSettings({ dest: 'api.test' });
  });

  it('start_proxy returns the port, and surfaces start failures as errors', async () => {
    await expect(handlers.start_proxy()).resolves.toEqual({
      running: true,
      port: 8000,
      tab: { id: 't1', name: 'api.test' },
    });
    ctx.proxyHost.start.mockRejectedValueOnce({ code: 'EADDRINUSE', message: 'EADDRINUSE' });
    await expect(handlers.start_proxy()).rejects.toThrow('EADDRINUSE');
  });

  it('start_proxy needs a destination', async () => {
    setSettings({ dest: '' });
    await expect(handlers.start_proxy()).rejects.toThrow(/Destination host is required/);
  });

  it('restart_proxy starts when stopped and restarts when running', async () => {
    await expect(handlers.restart_proxy()).resolves.toMatchObject({ running: true, port: 8000 });
    expect(ctx.proxyHost.restart).not.toHaveBeenCalled();
    await expect(handlers.restart_proxy()).resolves.toMatchObject({ running: true, port: 8123 });
    expect(ctx.proxyHost.restart).toHaveBeenCalledOnce();
  });

  it('stop_proxy stops the host', () => {
    setRunning();
    expect(handlers.stop_proxy()).toEqual({ running: false, tab: { id: 't1', name: 'api.test' } });
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

describe('compare_requests', () => {
  it('summarizes what differs and returns a unified diff of the bodies', () => {
    const ok = ctx.trafficStore.add({
      ...entry({ contentType: 'application/json', body: '{"user":{"id":1,"name":"a"},"ok":true}' }),
      request: {
        method: 'GET',
        url: '/me',
        headers: { authorization: 'Bearer good', date: 'Mon', accept: '*/*' },
      },
    });
    const bad = ctx.trafficStore.add({
      ...entry({
        status: 401,
        contentType: 'application/json',
        body: '{"ok":false,"error":"expired"}',
      }),
      request: {
        method: 'GET',
        url: '/me',
        headers: { Authorization: 'Bearer old', date: 'Tue', accept: '*/*' },
      },
    });
    const c = handlers.compare_requests({
      trafficIdA: ok.trafficId,
      trafficIdB: bad.trafficId,
      ignoreHeaders: ['Date'],
    });
    expect(c.identical).toBe(false);
    expect(c.summary[0]).toBe('status: 200 → 401');
    expect(c.summary).toContain('request header authorization: "Bearer good" → "Bearer old"');
    // Unchanged fields (accept, method, url) are left out by default; ignored ones always.
    expect(c.requestHeaders.map((h) => h.name)).toEqual(['authorization']);
    expect(c.requestLine).toEqual([]);
    expect(c.status).toMatchObject({ a: '200', b: '401', status: 'changed' });
    expect(c.requestBody).toEqual({
      equal: true,
      a: { kind: 'empty', bytes: 0 },
      b: { kind: 'empty', bytes: 0 },
    });
    expect(c.responseBody.equal).toBe(false);
    expect(c.responseBody.a.kind).toBe('json');
    expect(c.responseBody.diff).toContain('-  "ok": true,');
    expect(c.responseBody.diff).toContain('+  "error": "expired",');
    expect(c.responseBody.diff.startsWith('@@ ')).toBe(true);

    const all = handlers.compare_requests({
      trafficIdA: ok.trafficId,
      trafficIdB: bad.trafficId,
      includeUnchanged: true,
    });
    expect(all.requestHeaders.map((h) => h.name)).toEqual(['accept', 'authorization', 'date']);
    expect(all.requestLine.map((f) => f.name)).toEqual(['method', 'url']);
  });

  it('reports identical exchanges', () => {
    const a = ctx.trafficStore.add(entry({ body: 'same' }));
    const b = ctx.trafficStore.add(entry({ body: 'same' }));
    const c = handlers.compare_requests({ trafficIdA: a.trafficId, trafficIdB: b.trafficId });
    expect(c.identical).toBe(true);
    expect(c.summary).toEqual([]);
    expect(c.responseBody.diff).toBeUndefined();
  });

  it('validates both ids', () => {
    const a = ctx.trafficStore.add(entry());
    expect(() => handlers.compare_requests({ trafficIdA: a.trafficId })).toThrow(/trafficIdB/);
    expect(() => handlers.compare_requests({ trafficIdA: a.trafficId, trafficIdB: 999 })).toThrow(
      /no traffic entry with id 999/
    );
    expect(() => handlers.compare_requests({ trafficIdA: 998, trafficIdB: a.trafficId })).toThrow(
      /no traffic entry with id 998/
    );
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
    // Recorded in the tab the original came from.
    expect(result.tabId).toBe('t1');
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

  it('does not ask for a destination in capture-anything mode', () => {
    setSettings({ dest: '', captureAll: true });
    const byName = Object.fromEntries(handlers.validate_setup().checks.map((c) => [c.name, c.ok]));
    expect(byName['destination-configured']).toBe(true);
    setSettings({ captureAll: false });
  });

  it('passes once configured', () => {
    setSettings({ dest: 'api.test' });
    certStatus = { ...VALID_CERT };
    const result = handlers.validate_setup();
    expect(result.ok).toBe(true);
    const cert = result.checks.find((c) => c.name === 'root-certificate');
    expect(cert.detail).toBe('root CA valid until 2036-05-01');
  });

  it('fails on an expired root CA and says how to fix it', () => {
    setSettings({ dest: 'api.test' });
    certStatus = {
      notAfter: '2025-01-02T00:00:00.000Z',
      daysLeft: -300,
      expired: true,
      expiringSoon: true,
    };
    const result = handlers.validate_setup();
    expect(result.ok).toBe(false);
    const cert = result.checks.find((c) => c.name === 'root-certificate');
    expect(cert.detail).toMatch(/expired on 2025-01-02.*regenerate_root_cert/);
  });

  it('warns, without failing, when the root CA expires soon', () => {
    setSettings({ dest: 'api.test' });
    certStatus = { ...VALID_CERT, daysLeft: 12, expiringSoon: true };
    const result = handlers.validate_setup();
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'root-certificate').detail).toMatch(/12 days left/);
  });

  it('fails when the saved root key could not be unlocked', () => {
    setSettings({ dest: 'api.test' });
    certStatus = { ...VALID_CERT, temporary: true, temporaryReason: 'keychain locked' };
    const cert = handlers.validate_setup().checks.find((c) => c.name === 'root-certificate');
    expect(cert.ok).toBe(false);
    expect(cert.detail).toMatch(/keychain locked/);
  });

  it('checks that a configured upstream client certificate is readable', () => {
    setSettings({
      dest: 'api.test',
      upstreamClientCertPath: '/nope/cert.pem',
      upstreamClientKeyPath: '/nope/key.pem',
    });
    certStatus = { ...VALID_CERT };
    const result = handlers.validate_setup();
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === 'upstream-client-certificate');
    expect(check.detail).toMatch(/cannot read \/nope\/cert.pem/);
  });

  it('regenerate_root_cert returns the new validity', async () => {
    expect(await handlers.regenerate_root_cert()).toEqual(VALID_CERT);
    expect(ctx.regenerateRootCert).toHaveBeenCalledOnce();
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

describe('breakpoint tools', () => {
  it('set_breakpoints validates, assigns the UI ids, dedupes, and applies the rules', () => {
    const result = handlers.set_breakpoints({
      rules: [
        { path: '^/api', methods: ['post', 'GET'] },
        { path: '^/api', methods: ['GET', 'POST'] }, // same rule, different order
        { path: '/pay', phase: 'response' },
      ],
    });
    expect(result).toEqual([
      { id: 'GET,POST ^/api', path: '^/api', methods: ['POST', 'GET'], phase: 'request' },
      {
        id: 'response DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT /pay',
        path: '/pay',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
        phase: 'response',
      },
    ]);
    expect(ctx.proxyHost.setBreakpoints).toHaveBeenCalledWith(result);
    expect(handlers.list_breakpoints()).toEqual(result);

    expect(handlers.set_breakpoints({ rules: [] })).toEqual([]);
  });

  it('set_breakpoints rejects bad input without changing the rules', () => {
    expect(() => handlers.set_breakpoints({})).toThrow(/rules \(array\) is required/);
    expect(() => handlers.set_breakpoints({ rules: [{ path: '(' }] })).toThrow(
      /not a valid regular expression/
    );
    expect(() => handlers.set_breakpoints({ rules: [{ path: '/x', phase: 'later' }] })).toThrow(
      /phase must be/
    );
    expect(() => handlers.set_breakpoints({ rules: [{ path: '/x', methods: [] }] })).toThrow(
      /must not be empty/
    );
    expect(ctx.proxyHost.setBreakpoints).not.toHaveBeenCalled();
  });

  it('lists held exchanges with readable bodies, numbered across tabs', () => {
    [
      {
        id: 4,
        phase: 'request',
        url: '/a',
        method: 'POST',
        headers: { 'x-a': '1' },
        body: Buffer.from('req body'),
      },
      {
        id: 5,
        phase: 'response',
        url: '/b',
        method: 'GET',
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('res body'),
      },
    ].forEach(hold);
    // The worker's own ids (4, 5) are replaced by ids unique across tabs.
    expect(handlers.list_held_requests()).toEqual([
      {
        id: 1,
        phase: 'request',
        method: 'POST',
        url: '/a',
        statusCode: undefined,
        headers: { 'x-a': '1' },
        body: 'req body',
      },
      {
        id: 2,
        phase: 'response',
        method: 'GET',
        url: '/b',
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'res body',
      },
    ]);
  });

  it('resumes a held request with merged edits', () => {
    const id = hold({
      id: 4,
      phase: 'request',
      url: '/a',
      method: 'POST',
      headers: { 'x-a': '1', 'x-drop': 'y' },
      body: Buffer.from('orig'),
    });
    const result = handlers.resume_held_request({
      id,
      edits: { url: '/edited', headers: { 'x-new': '2', 'x-drop': null }, body: 'changed' },
    });
    expect(result).toEqual({ resumed: id, phase: 'request' });
    // The worker is told its own id.
    expect(ctx.proxyHost.resumeBreakpoint).toHaveBeenCalledWith(4, {
      url: '/edited',
      method: 'POST',
      headers: { 'x-a': '1', 'x-new': '2' },
      body: 'changed',
      statusCode: undefined,
    });
  });

  it('resumes a held response unchanged or with a new status', () => {
    const hit = {
      id: 5,
      phase: 'response',
      url: '/b',
      method: 'GET',
      statusCode: 200,
      headers: {},
      body: Buffer.from('ok'),
    };
    handlers.resume_held_request({ id: hold(hit) });
    expect(ctx.proxyHost.resumeBreakpoint).toHaveBeenLastCalledWith(5, {
      url: '/b',
      method: 'GET',
      headers: {},
      body: hit.body,
      statusCode: 200,
    });
    handlers.resume_held_request({ id: hold(hit), edits: { statusCode: 503 } });
    expect(ctx.proxyHost.resumeBreakpoint.mock.lastCall[1].statusCode).toBe(503);
    expect(handlers.list_held_requests()).toEqual([]);
  });

  it('rejects resuming something that is not held', () => {
    expect(() => handlers.resume_held_request({ id: 9 })).toThrow(/nothing is held with id 9/);
    expect(() => handlers.resume_held_request({})).toThrow(/id \(number\) is required/);
  });
});

describe('export_har', () => {
  it('writes the (filtered) traffic as a HAR file', () => {
    ctx.trafficStore.add(
      entry({ url: '/keep', status: 500, target: { protocol: 'http', host: 'a.test', port: 80 } })
    );
    ctx.trafficStore.add(entry({ url: '/skip', status: 200 }));
    const file = path.join(protoDir, 'out.har');
    expect(handlers.export_har({ path: file, hasError: true })).toMatchObject({
      path: file,
      entries: 1,
    });
    const har = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'Reversee', version: '9.9.9-test' });
    expect(har.log.entries.map((e) => e.request.url)).toEqual(['http://a.test/keep']);

    expect(handlers.export_har({ path: file })).toMatchObject({ path: file, entries: 2 });
  });

  it('requires an absolute path', () => {
    expect(() => handlers.export_har({ path: 'relative.har' })).toThrow(/absolute/);
    expect(() => handlers.export_har({})).toThrow(/absolute/);
  });
});

describe('new entry fields in tool output', () => {
  it('summaries flag pending, mocked and WebSocket entries', () => {
    ctx.trafficStore.add(entry({ url: '/slow', status: undefined, pending: true }));
    ctx.trafficStore.add(entry({ url: '/mock', mocked: true }));
    ctx.trafficStore.add(
      entry({ url: '/ws', status: 101, ws: { messages: [], messageCount: 7, closed: true } })
    );
    const { entries } = handlers.list_traffic();
    expect(entries[0]).toMatchObject({ url: '/slow', pending: true });
    expect(entries[1]).toMatchObject({ url: '/mock', mocked: true });
    expect(entries[2]).toMatchObject({ url: '/ws', webSocket: true, webSocketMessages: 7 });
    expect(entries[1].pending).toBeUndefined();
  });

  it('get_traffic_entry returns WebSocket messages and interceptor diagnostics', () => {
    const stored = ctx.trafficStore.add(
      entry({
        url: '/ws',
        status: 101,
        ws: {
          messages: [{ from: 'client', opcode: 'text', text: 'hi', size: 2, atMs: 5 }],
          messageCount: 1,
        },
        interceptorErrors: [{ phase: 'request', message: 'boom' }],
        interceptorLogs: ['hello'],
      })
    );
    const full = handlers.get_traffic_entry({ trafficId: stored.trafficId });
    expect(full.webSocket).toEqual({
      closed: false,
      messageCount: 1,
      messages: [{ from: 'client', opcode: 'text', text: 'hi', size: 2, atMs: 5 }],
    });
    expect(full.interceptorErrors).toEqual([{ phase: 'request', message: 'boom' }]);
    expect(full.interceptorLogs).toEqual(['hello']);
    expect(full.interceptorError).toBe(true);
  });
});

describe('route and mock tools', () => {
  it('list_rules starts empty and explains the order', () => {
    handlers.update_config({ dest: 'api.example.com', destProtocol: 'https', destPort: 443 });
    const view = handlers.list_rules();
    expect(view).toMatchObject({
      proxyRunning: false,
      defaultDestination: 'https://api.example.com:443',
      mocks: [],
      routes: [],
    });
    expect(view.note).toMatch(/first enabled mock/);
  });

  it('add_mock stores a rule built from plain input, newest first', () => {
    const first = handlers.add_mock({ path: '/api/flags', body: { beta: true } });
    expect(first.applied).toMatch(/takes effect when the proxy starts/);
    expect(first.added).toMatchObject({
      pathPattern: '^/api/flags(?:\\?.*)?$',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      summary: 'any method, path is "/api/flags" -> 200',
    });
    setRunning();
    const second = handlers.add_mock({ path: '/pay', status: 500, name: 'Pay down' });
    expect(second.applied).toBe('active now on the running proxy');
    handlers.add_mock({ path: '/last', priority: 'last' });

    const { mocks, proxyRunning } = handlers.list_rules();
    expect(proxyRunning).toBe(true);
    expect(mocks.map((m) => m.summary)).toEqual([
      'any method, path is "/pay" -> 500',
      'any method, path is "/api/flags" -> 200',
      'any method, path is "/last" -> 200',
    ]);
    expect(mocks[0].name).toBe('Pay down');
    // Stored in settings, so the window and get_config see the same rules.
    expect(handlers.get_config().mocks).toHaveLength(3);
  });

  it('record_mocks saves captured traffic as mocks, filtered or by id', () => {
    const users = ctx.trafficStore.add(
      entry({ url: '/api/users', contentType: 'application/json', body: '[1,2]' })
    );
    ctx.trafficStore.add(
      entry({ url: '/api/users', contentType: 'application/json', body: '[1,2,3]' })
    );
    const img = ctx.trafficStore.add(
      entry({ url: '/img.png', contentType: 'image/png', body: '\u00ff' })
    );
    img.response.body = Buffer.from([0xff, 0xd8, 0x00]);
    ctx.trafficStore.add(entry({ url: '/live', pending: true }));

    const result = handlers.record_mocks({ urlContains: '/api' });
    expect(result).toMatchObject({
      considered: 2,
      created: 1,
      replaced: 0,
      overLimit: 0,
      applied: expect.stringMatching(/takes effect when the proxy starts/),
    });
    expect(result.mocks).toEqual([
      {
        id: expect.any(String),
        fromTrafficId: users.trafficId + 1,
        summary: 'GET, path is "/api/users" -> 200',
        bodyBytes: 7,
      },
    ]);
    expect(result.skipped[0]).toMatchObject({ count: 1, trafficIds: [users.trafficId] });
    const saved = handlers.list_rules().mocks;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'Recorded: GET /api/users', body: '[1,2,3]' });

    // Recording the same request again updates the saved mock in place.
    const again = handlers.record_mocks({ trafficIds: [users.trafficId] });
    expect(again).toMatchObject({ created: 0, replaced: 1 });
    expect(again.mocks[0].id).toBe(saved[0].id);
    expect(handlers.list_rules().mocks[0].body).toBe('[1,2]');

    // Everything: the image is kept as base64, the pending request skipped.
    const all = handlers.record_mocks({ ignoreQuery: true, enabled: false });
    expect(all).toMatchObject({ considered: 4, created: 1, replaced: 1 });
    expect(all.mocks.find((m) => m.summary.includes('/img.png'))).toMatchObject({
      bodyBytes: 3,
      bodyEncoding: 'base64',
    });
    expect(all.skipped.map((s) => s.reason)).toContain('still in flight');
    const mocks = handlers.list_rules().mocks;
    expect(mocks.find((m) => m.name === 'Recorded: GET /img.png')).toMatchObject({
      enabled: false,
      bodyEncoding: 'base64',
      body: Buffer.from([0xff, 0xd8, 0x00]).toString('base64'),
    });
  });

  it('record_mocks rejects bad input and empty selections', () => {
    expect(() => handlers.record_mocks({ trafficIds: 'x' })).toThrow(/array of request ids/);
    expect(() => handlers.record_mocks({})).toThrow(/no captured requests match/);
    ctx.trafficStore.add(entry({ url: '/a' }));
    expect(() => handlers.record_mocks({ trafficIds: [999] })).toThrow(/no captured requests/);
    expect(handlers.list_rules().mocks).toEqual([]);
  });

  it('record_mocks is gated as a mutating tool', () => {
    expect(MCP_MUTATING_METHODS.has('record_mocks')).toBe(true);
  });

  it('add_route stores a route to a target URL', () => {
    const { added } = handlers.add_route({ path: '/api/v2', target: 'http://localhost:3001' });
    expect(added).toMatchObject({
      pathPattern: '^/api/v2',
      destProtocol: 'http',
      dest: 'localhost',
      destPort: 3001,
      summary: 'path starts with "/api/v2" -> http://localhost:3001',
    });
    handlers.add_route({ host: 'a.test', target: 'https://b.test', priority: 'last' });
    handlers.add_route({ path: '/first', target: 'localhost:1' });
    expect(handlers.list_rules().routes.map((r) => r.dest)).toEqual([
      'localhost',
      'localhost',
      'b.test',
    ]);
  });

  it('rejects bad input without changing the rules', () => {
    expect(() => handlers.add_mock({})).toThrow(/path is required/);
    expect(() => handlers.add_mock()).toThrow(/path is required/);
    expect(() => handlers.add_route({ path: '/x' })).toThrow(/target is required/);
    expect(() => handlers.add_route()).toThrow(/target is required/);
    expect(handlers.list_rules()).toMatchObject({ mocks: [], routes: [] });
  });

  it('update_rule switches a rule off and on', () => {
    const mock = handlers.add_mock({ path: '/m' }).added;
    const route = handlers.add_route({ path: '/r', target: 'localhost:1' }).added;
    expect(handlers.update_rule({ id: mock.id, enabled: false }).mocks[0].enabled).toBe(false);
    expect(handlers.update_rule({ id: route.id, enabled: false }).routes[0].enabled).toBe(false);
    const view = handlers.update_rule({ id: mock.id, enabled: true });
    expect(view.mocks[0].enabled).toBe(true);
    expect(view.routes[0].enabled).toBe(false);

    expect(() => handlers.update_rule({ enabled: true })).toThrow(/id \(string\) is required/);
    expect(() => handlers.update_rule()).toThrow(/id \(string\) is required/);
    expect(() => handlers.update_rule({ id: mock.id })).toThrow(/enabled \(boolean\) is required/);
    expect(() => handlers.update_rule({ id: 'nope', enabled: true })).toThrow(/no route or mock/);
  });

  it('remove_rule deletes one rule by id, or all of them', () => {
    const a = handlers.add_mock({ path: '/a' }).added;
    handlers.add_mock({ path: '/b' });
    const route = handlers.add_route({ path: '/r', target: 'localhost:1' }).added;

    const afterOne = handlers.remove_rule({ id: a.id });
    expect(afterOne.removed).toBe(1);
    expect(afterOne.mocks).toHaveLength(1);
    expect(handlers.remove_rule({ id: route.id }).routes).toEqual([]);

    expect(() => handlers.remove_rule({ id: a.id })).toThrow(/no route or mock has id/);
    expect(() => handlers.remove_rule({})).toThrow(/id \(string\) is required/);
    expect(() => handlers.remove_rule()).toThrow(/id \(string\) is required/);

    handlers.add_route({ path: '/r', target: 'localhost:1' });
    expect(handlers.remove_rule({ all: true })).toMatchObject({
      removed: 2,
      mocks: [],
      routes: [],
    });
  });
});
