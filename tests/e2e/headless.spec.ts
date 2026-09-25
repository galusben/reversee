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
