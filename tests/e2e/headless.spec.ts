// Headless (agent) mode end to end: the built app launched with --headless,
// driven only through the MCP control socket with the bridge's own client —
// the path `reversee --headless --allow-mcp-control` users rely on. No window
// is ever created.
import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReverseeClient, ControlCallError } from '../../mcp/src/client';
import { startUpstream, fetchViaProxy, freePort, type Upstream } from './fixtures/launch';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let app: ElectronApplication | null = null;
let upstream: Upstream | null = null;

test.afterEach(async () => {
  await app?.close().catch(() => app?.process().kill());
  await upstream?.close().catch(() => {});
  app = null;
  upstream = null;
});

async function launchHeadless(flags: string[]): Promise<ReverseeClient> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-headless-e2e-'));
  app = await electron.launch({
    args: [path.join(repoRoot, 'out', 'main', 'index.js'), '--headless', ...flags],
    env: { ...process.env, REVERSEE_USER_DATA: userDataDir, NODE_ENV: 'production' },
  });
  // The control socket writes its token once it is listening.
  await expect
    .poll(() => fs.existsSync(path.join(userDataDir, 'mcp-token')), { timeout: 20_000 })
    .toBe(true);
  const client = new ReverseeClient(userDataDir, 'e2e');
  await expect(async () => {
    await client.call('get_status');
  }).toPass({ timeout: 10_000 });
  return client;
}

test('headless with control: configure, proxy, inspect, and replay over MCP', async () => {
  upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  const client = await launchHeadless(['--allow-mcp-control']);
  expect(app!.windows()).toHaveLength(0);

  const { tools } = (await client.call('list_tools')) as { tools: Array<{ name: string }> };
  expect(tools.map((t) => t.name)).toEqual(
    expect.arrayContaining(['start_proxy', 'list_traffic', 'replay_request'])
  );

  const listenPort = await freePort();
  await client.call('update_config', {
    dest: '127.0.0.1',
    destProtocol: 'http',
    destPort: upstream.port,
    listenProtocol: 'http',
    listenPort,
  });
  expect(await client.call('start_proxy')).toEqual({ running: true, port: listenPort });

  const res = await fetchViaProxy(listenPort, '/agent/check');
  expect(res.statusCode).toBe(200);

  await expect
    .poll(async () => ((await client.call('list_traffic')) as { total: number }).total)
    .toBe(1);
  const { entries } = (await client.call('list_traffic')) as {
    entries: Array<{ trafficId: number; url: string; statusCode: number }>;
  };
  expect(entries[0]).toMatchObject({ url: '/agent/check', statusCode: 200 });

  const full = (await client.call('get_traffic_entry', { trafficId: entries[0].trafficId })) as {
    response: { body: string };
  };
  expect(JSON.parse(full.response.body)).toEqual({ path: '/agent/check', method: 'GET' });

  const replayed = (await client.call('replay_request', {
    trafficId: entries[0].trafficId,
    overrides: { method: 'POST', url: '/agent/replayed' },
  })) as { replay: boolean; response: { body: string } };
  expect(replayed.replay).toBe(true);
  expect(JSON.parse(replayed.response.body)).toEqual({ path: '/agent/replayed', method: 'POST' });

  const status = (await client.call('get_status')) as { running: boolean; trafficCount: number };
  expect(status).toMatchObject({ running: true, trafficCount: 2 });
  expect(await client.call('stop_proxy')).toEqual({ running: false });
  await expect
    .poll(async () => ((await client.call('get_status')) as { running: boolean }).running)
    .toBe(false);
});

test('headless without --allow-mcp-control is read-only', async () => {
  const client = await launchHeadless([]);
  expect(await client.call('get_config')).toHaveProperty('listenPort');
  expect(
    ((await client.call('validate_setup')) as { checks: unknown[] }).checks.length
  ).toBeGreaterThan(0);

  for (const [method, params] of [
    ['start_proxy', undefined],
    ['update_config', { dest: 'evil.test' }],
  ] as const) {
    const error = await client.call(method, params).catch((e) => e);
    expect(error, method).toBeInstanceOf(ControlCallError);
  }
  expect(((await client.call('get_config')) as { dest: string }).dest).toBe('');
});

test('headless: breakpoints, mocks, HAR export and setup checks over MCP', async () => {
  upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream saw ${req.url} flag=${req.headers['x-flag'] ?? 'none'}`);
  });
  const client = await launchHeadless(['--allow-mcp-control']);

  // The new tools are advertised by the app-owned catalog.
  const { tools } = (await client.call('list_tools')) as { tools: Array<{ name: string }> };
  expect(tools.map((t) => t.name)).toEqual(
    expect.arrayContaining([
      'set_breakpoints',
      'list_held_requests',
      'resume_held_request',
      'export_har',
      'regenerate_root_cert',
    ])
  );

  const setup = (await client.call('validate_setup')) as {
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  };
  const cert = setup.checks.find((c) => c.name === 'root-certificate')!;
  expect(cert.ok).toBe(true);
  expect(cert.detail).toMatch(/^root CA valid until \d{4}-\d{2}-\d{2}$/);
  expect(setup.checks.find((c) => c.name === 'upstream-client-certificate')!.detail).toBe(
    'not configured'
  );

  const listenPort = await freePort();
  await client.call('update_config', {
    dest: '127.0.0.1',
    destProtocol: 'http',
    destPort: upstream.port,
    listenProtocol: 'http',
    listenPort,
    mocks: [
      {
        id: 'health',
        enabled: true,
        pathPattern: '^/health$',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"mocked":true}',
      },
      { id: 'broken', enabled: true, pathPattern: '(', statusCode: 200 }, // dropped: bad regex
    ],
  });
  expect(((await client.call('get_config')) as { mocks: unknown[] }).mocks).toHaveLength(1);

  const rules = (await client.call('set_breakpoints', {
    rules: [
      { path: '^/hold-request', methods: ['GET'] },
      { path: '^/hold-response', methods: ['GET'], phase: 'response' },
    ],
  })) as Array<{ id: string; phase: string }>;
  expect(rules.map((r) => r.phase)).toEqual(['request', 'response']);
  expect(await client.call('list_breakpoints')).toEqual(rules);
  await client.call('start_proxy');

  // A mock answers without the upstream.
  const mocked = await fetchViaProxy(listenPort, '/health');
  expect(mocked.body).toBe('{"mocked":true}');
  expect(upstream.requests).toHaveLength(0);

  type Held = { id: number; phase: string; url: string; statusCode?: number; body: string };
  const heldNow = async (): Promise<Held[]> => (await client.call('list_held_requests')) as Held[];

  // Hold a request, edit it, resume it.
  const first = fetchViaProxy(listenPort, '/hold-request/1');
  await expect.poll(async () => (await heldNow()).length).toBe(1);
  const [heldRequest] = await heldNow();
  expect(heldRequest).toMatchObject({ phase: 'request', url: '/hold-request/1' });
  expect(upstream.requests).toHaveLength(0);
  expect(
    await client.call('resume_held_request', {
      id: heldRequest.id,
      edits: { url: '/rewritten', headers: { 'x-flag': 'by-agent' } },
    })
  ).toEqual({ resumed: heldRequest.id, phase: 'request' });
  expect((await first).body).toBe('upstream saw /rewritten flag=by-agent');
  expect(await heldNow()).toEqual([]);

  // Hold a response, change its status and body.
  const second = fetchViaProxy(listenPort, '/hold-response/1');
  await expect.poll(async () => (await heldNow()).length).toBe(1);
  const [heldResponse] = await heldNow();
  expect(heldResponse).toMatchObject({
    phase: 'response',
    statusCode: 200,
    body: 'upstream saw /hold-response/1 flag=none',
  });
  await client.call('resume_held_request', {
    id: heldResponse.id,
    edits: { statusCode: 503, body: 'injected outage' },
  });
  const edited = await second;
  expect(edited.statusCode).toBe(503);
  expect(edited.body).toBe('injected outage');

  const stale = await client.call('resume_held_request', { id: heldResponse.id }).catch((e) => e);
  expect(stale).toBeInstanceOf(ControlCallError);

  // Summaries carry the new facts.
  const { entries } = (await client.call('list_traffic')) as {
    entries: Array<{ url: string; mocked?: boolean; statusCode: number; responseBytes: number }>;
  };
  expect(entries.find((e) => e.url === '/health')).toMatchObject({
    mocked: true,
    responseBytes: 15,
  });
  expect(entries.find((e) => e.url === '/hold-response/1')!.statusCode).toBe(503);

  // Export only the failures to a HAR file.
  const harFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-har-mcp-')), 'out.har');
  expect(await client.call('export_har', { path: harFile, hasError: true })).toEqual({
    path: harFile,
    entries: 1,
  });
  const har = JSON.parse(fs.readFileSync(harFile, 'utf8'));
  expect(har.log.entries[0].response.status).toBe(503);
  expect(har.log.entries[0].response.content.text).toBe('injected outage');

  // Clearing the rules stops holding.
  expect(await client.call('set_breakpoints', { rules: [] })).toEqual([]);
  expect((await fetchViaProxy(listenPort, '/hold-request/2')).statusCode).toBe(200);
});

test('headless read-only: the new mutating tools are gated, the listing ones are not', async () => {
  const client = await launchHeadless([]);
  expect(await client.call('list_held_requests')).toEqual([]);
  for (const [method, params] of [
    ['set_breakpoints', { rules: [] }],
    ['resume_held_request', { id: 1 }],
    ['export_har', { path: path.join(os.tmpdir(), 'should-not-exist.har') }],
    ['regenerate_root_cert', undefined],
  ] as const) {
    const error = await client.call(method, params).catch((e) => e);
    expect(error, method).toBeInstanceOf(ControlCallError);
    expect((error as ControlCallError).message, method).toMatch(/control is disabled/i);
  }
});

test('headless: rule tools apply to the running proxy without a restart', async () => {
  upstream = await startUpstream((req, res) => res.end(`upstream ${req.url}`));
  const other = await startUpstream((req, res) => res.end(`other ${req.url}`));
  const client = await launchHeadless(['--allow-mcp-control']);
  try {
    const listenPort = await freePort();
    await client.call('update_config', {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort: upstream.port,
      listenProtocol: 'http',
      listenPort,
    });
    await client.call('start_proxy');
    expect((await fetchViaProxy(listenPort, '/api/flags')).body).toBe('upstream /api/flags');

    const mock = (await client.call('add_mock', {
      path: '/api/flags',
      body: { beta: true },
      name: 'Flags',
    })) as { added: { id: string; summary: string }; applied: string };
    expect(mock.applied).toBe('active now on the running proxy');
    await expect
      .poll(async () => (await fetchViaProxy(listenPort, '/api/flags?u=1')).body)
      .toBe('{\n  "beta": true\n}');

    await client.call('add_route', { path: '/v2', target: `http://127.0.0.1:${other.port}` });
    await expect
      .poll(async () => (await fetchViaProxy(listenPort, '/v2/items')).body)
      .toBe('other /v2/items');

    const listed = (await client.call('list_rules')) as {
      proxyRunning: boolean;
      mocks: Array<{ id: string; summary: string }>;
      routes: Array<{ summary: string }>;
    };
    expect(listed.proxyRunning).toBe(true);
    expect(listed.mocks[0]!.summary).toBe('any method, path is "/api/flags" -> 200');
    expect(listed.routes[0]!.summary).toBe(
      `path starts with "/v2" -> http://127.0.0.1:${other.port}`
    );

    await client.call('update_rule', { id: mock.added.id, enabled: false });
    await expect
      .poll(async () => (await fetchViaProxy(listenPort, '/api/flags')).body)
      .toBe('upstream /api/flags');

    await client.call('remove_rule', { all: true });
    await expect
      .poll(async () => (await fetchViaProxy(listenPort, '/v2/items')).body)
      .toBe('upstream /v2/items');
    expect(((await client.call('get_status')) as { running: boolean }).running).toBe(true);
  } finally {
    await other.close();
  }
});

test('headless: an agent tries a script, installs it live, and switches it off', async () => {
  upstream = await startUpstream((req, res) => res.end(`upstream ${req.headers['x-tag'] ?? '-'}`));
  const client = await launchHeadless(['--allow-mcp-control']);
  const listenPort = await freePort();
  await client.call('update_config', {
    dest: '127.0.0.1',
    destProtocol: 'http',
    destPort: upstream.port,
    listenProtocol: 'http',
    listenPort,
  });
  await client.call('start_proxy');
  expect((await fetchViaProxy(listenPort, '/a')).body).toBe('upstream -');
  const [captured] = (
    (await client.call('list_traffic')) as { entries: Array<{ trafficId: number }> }
  ).entries;

  // Dry run in the real worker: nothing is sent and nothing is installed.
  const sent = upstream.requests.length;
  const trial = (await client.call('try_interceptor', {
    kind: 'request',
    trafficId: captured!.trafficId,
    code: "requestParams.headers['x-tag'] = 'tagged'; console.log(requestParams.path)",
  })) as { changes: string[]; logs: string[]; error?: string };
  expect(trial.changes).toEqual(['header x-tag added: tagged']);
  expect(trial.logs).toEqual(['/a']);
  expect(trial.error).toBeUndefined();
  expect(upstream.requests).toHaveLength(sent);
  expect((await fetchViaProxy(listenPort, '/a')).body).toBe('upstream -');

  const broken = (await client.call('try_interceptor', {
    kind: 'response',
    trafficId: captured!.trafficId,
    code: 'while (true) {}',
  })) as { error?: string };
  expect(broken.error).toMatch(/timed out after 1000 ms/);

  const installed = (await client.call('set_interceptor', {
    kind: 'request',
    code: "requestParams.headers['x-tag'] = 'tagged'",
    enabled: true,
  })) as { applied: string };
  expect(installed.applied).toBe('active now on the running proxy');
  await expect
    .poll(async () => (await fetchViaProxy(listenPort, '/a')).body)
    .toBe('upstream tagged');

  await client.call('set_interceptor', { kind: 'request', enabled: false });
  await expect.poll(async () => (await fetchViaProxy(listenPort, '/a')).body).toBe('upstream -');
  expect(((await client.call('get_status')) as { running: boolean }).running).toBe(true);
});

test('headless: trying a script is gated behind control', async () => {
  const client = await launchHeadless([]);
  const error = await client
    .call('try_interceptor', { kind: 'request', trafficId: 0, code: '' })
    .catch((e) => e);
  expect(error).toBeInstanceOf(ControlCallError);
});

test('headless: the rule tools are gated behind control', async () => {
  const client = await launchHeadless([]);
  expect(((await client.call('list_rules')) as { mocks: unknown[] }).mocks).toEqual([]);
  for (const [method, params] of [
    ['add_mock', { path: '/x' }],
    ['add_route', { path: '/x', target: 'http://localhost:1' }],
    ['update_rule', { id: 'x', enabled: false }],
    ['remove_rule', { all: true }],
  ] as const) {
    const error = await client.call(method, params).catch((e) => e);
    expect(error, method).toBeInstanceOf(ControlCallError);
  }
});
