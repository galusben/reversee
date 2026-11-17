// End-to-end coverage of the 2.3 feature set, through the real built app:
// streaming, WebSockets, mocks and routes, response breakpoints, replay, HAR,
// table sorting / keyboard / shortcuts, dark mode, the root-certificate
// lifecycle, interceptor diagnostics, upstream timeouts and mutual TLS.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import forge from 'node-forge';
import {
  launchApp,
  startUpstream,
  fetchViaProxy,
  freePort,
  type LaunchedApp,
  type Upstream,
} from './fixtures/launch';
import { startWsEchoServer, type WsEchoServer } from '../fixtures/ws-echo';

let launched: LaunchedApp | null = null;
const closers: Array<() => Promise<unknown>> = [];

test.afterEach(async () => {
  const rendererErrors = launched?.rendererErrors ?? [];
  await launched?.close().catch(() => {});
  launched = null;
  for (const close of closers.splice(0)) await close().catch(() => {});
  expect(rendererErrors, 'renderer console errors / uncaught exceptions').toEqual([]);
});

async function upstreamOf(
  handler?: Parameters<typeof startUpstream>[0],
  options?: Parameters<typeof startUpstream>[1]
): Promise<Upstream> {
  const upstream = await startUpstream(handler, options);
  closers.push(() => upstream.close());
  return upstream;
}

/** Launches the app pointed at `destPort`, starts the proxy, returns the page + listen port. */
async function startProxied(
  destPort: number,
  settings: Record<string, unknown> = {},
  config?: Record<string, unknown>
): Promise<{ page: Page; listenPort: number }> {
  const listenPort = await freePort();
  launched = await launchApp({
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort,
      listenProtocol: 'http',
      listenPort,
      ...settings,
    },
    config,
  });
  const { page } = launched;
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(`Proxy running on port ${listenPort}`)).toBeVisible();
  return { page, listenPort };
}

const row = (page: Page, text: string | RegExp) => page.getByRole('row').filter({ hasText: text });

function clickMenu(labels: string[]): Promise<void> {
  return launched!.app.evaluate(({ Menu }, labels) => {
    let items = Menu.getApplicationMenu()?.items ?? [];
    let item;
    for (const label of labels) {
      item = items.find((i) => i.label === label);
      if (!item) throw new Error(`menu item not found: ${label}`);
      items = item.submenu?.items ?? [];
    }
    item!.click();
  }, labels);
}

/** Order of the request ids currently rendered in the table. */
const shownIds = (page: Page) =>
  page
    .locator('tr[data-traffic-id]')
    .evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-traffic-id'))));

test('server-sent events stream through live and show as in flight until they end', async () => {
  let finish: () => void = () => {};
  const upstream = await upstreamOf((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    finish = () => res.end('data: last\n\n');
  });
  const { page, listenPort } = await startProxied(upstream.port);

  const chunks: string[] = [];
  const ended = new Promise<void>((resolve) => {
    http.get({ hostname: '127.0.0.1', port: listenPort, path: '/events' }, (res) => {
      res.on('data', (c: Buffer) => chunks.push(c.toString()));
      res.on('end', resolve);
    });
  });

  // The client has the first event while the upstream response is still open...
  await expect.poll(() => chunks.join('')).toBe('data: first\n\n');
  // ...and the app shows the exchange as in flight, with what has arrived so far.
  const events = row(page, '/events');
  await expect(events).toBeVisible();
  await expect(events).toHaveClass(/italic/);
  await expect(page.getByLabel('Request count')).toHaveText('1 request, 1 in flight');
  await events.click();
  await expect(page.getByLabel('Request summary')).toContainText('in flight');
  await expect(page.getByText('data: first').first()).toBeVisible({ timeout: 15_000 });

  finish();
  await ended;
  expect(chunks.join('')).toBe('data: first\n\ndata: last\n\n');
  await expect(events).not.toHaveClass(/italic/);
  await expect(events).toContainText('200');
  await expect(events).toContainText('25 B'); // size column
  await expect(page.getByLabel('Request count')).toHaveText('1 request');
});

test('WebSocket connections are tunnelled and their messages listed', async () => {
  const echo: WsEchoServer = await startWsEchoServer({ deflate: true });
  closers.push(() => echo.close());
  const { page, listenPort } = await startProxied(echo.port);

  const ws = new WebSocket(`ws://127.0.0.1:${listenPort}/live`);
  const received: string[] = [];
  ws.addEventListener('message', (e) => received.push(String(e.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('websocket did not open')));
  });
  ws.send('hello through reversee');
  await expect.poll(() => received).toEqual(['welcome', 'echo: hello through reversee']);

  const live = row(page, '/live');
  await expect(live).toContainText('WS');
  await expect(live).toContainText('101');
  await live.click();
  // The Messages tab is the default for a WebSocket entry.
  const messages = page.getByRole('list', { name: 'WebSocket messages' }).getByRole('listitem');
  await expect(messages).toHaveCount(3);
  await expect(messages.nth(0)).toContainText('welcome');
  await expect(messages.nth(1)).toContainText('hello through reversee');
  await expect(messages.nth(2)).toContainText('echo: hello through reversee');
  await expect(page.getByText('open', { exact: true })).toBeVisible();

  ws.close(1000, 'bye');
  await expect(page.getByText('closed', { exact: true })).toBeVisible();
  await expect(messages.last()).toContainText('close 1000');
  await expect(live).not.toHaveClass(/italic/);
});

test('a mock rule added in the Rules dialog answers without the upstream; a route diverts', async () => {
  const main = await upstreamOf((_req, res) => res.end('main upstream'));
  const other = await upstreamOf((req, res) => res.end(`other upstream ${req.headers.host}`));
  const listenPort = await freePort();
  launched = await launchApp({
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort: main.port,
      listenProtocol: 'http',
      listenPort,
      routes: [
        {
          id: 'v2',
          enabled: true,
          pathPattern: '^/v2/',
          destProtocol: 'http',
          dest: '127.0.0.1',
          destPort: other.port,
        },
      ],
    },
  });
  const { page } = launched;

  const rulesButton = page.getByRole('button', { name: /Routes and mocks/ });
  await expect(rulesButton).toHaveAccessibleName('Routes and mocks, 1 active');
  await rulesButton.click();
  const dialog = page.getByRole('dialog', { name: 'Routes and mocks' });
  // With only routes saved the screen opens on them, shown as a plain match.
  await expect(dialog.getByLabel('Route 1 path match')).toHaveValue('prefix');
  await expect(dialog.getByLabel('Route 1 path', { exact: true })).toHaveValue('/v2/');
  await dialog.getByRole('tab', { name: /Mocks/ }).click();
  await expect(dialog.getByText('No mocks yet.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add mock' }).click();
  // Not saveable until the rule is valid.
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByLabel('Mock 1 path', { exact: true }).fill('/api/flags');
  await dialog.getByLabel('Mock 1 status').fill('418');
  await dialog.getByLabel('Mock 1 body').fill('{"feature":"on"}');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rulesButton).toHaveAccessibleName('Routes and mocks, 2 active');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(/Proxy running/)).toBeVisible();

  const mocked = await fetchViaProxy(listenPort, '/api/flags?user=1');
  expect(mocked.statusCode).toBe(418);
  expect(mocked.headers['content-type']).toBe('application/json');
  expect(mocked.body).toBe('{"feature":"on"}');
  expect(main.requests).toHaveLength(0);

  const routed = await fetchViaProxy(listenPort, '/v2/users');
  expect(routed.body).toBe(`other upstream 127.0.0.1:${other.port}`);
  expect((await fetchViaProxy(listenPort, '/v1/users')).body).toBe('main upstream');

  await expect(row(page, '/api/flags')).toContainText('MOCK');
  await expect(row(page, '/api/flags')).toContainText('418');
  await row(page, '/api/flags').click();
  await expect(page.getByLabel('Request summary')).toContainText('answered by a mock rule');
  await row(page, '/v2/users').click();
  await expect(page.getByLabel('Request summary')).toContainText(
    `→ http://127.0.0.1:${other.port}`
  );

  // While the proxy runs: turn a captured response into a mock, edit it, and
  // see it answer the very next request. No restart.
  await row(page, '/v1/users').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mock This Response…' }).click();
  await expect(dialog.getByLabel('Mock 1 name')).toHaveValue('GET /v1/users');
  await expect(dialog.getByLabel('Mock 1 path', { exact: true })).toHaveValue('/v1/users');
  await expect(dialog.getByLabel('Mock 1 body')).toHaveValue('main upstream');
  await expect(dialog.getByText(/Matches 1 of 3 captured requests/)).toBeVisible();
  await expect(dialog.getByText(/applies the rules to the running proxy at once/)).toBeVisible();
  await dialog.getByLabel('Mock 1 body').fill('from the mock');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/Proxy running/)).toBeVisible();
  const before = main.requests.length;
  await expect
    .poll(async () => (await fetchViaProxy(listenPort, '/v1/users?live=1')).body)
    .toBe('from the mock');
  expect(main.requests).toHaveLength(before);
});

test('record and replay: captured traffic becomes mocks that answer with the upstream gone', async () => {
  const upstream = await upstreamOf((req, res) => {
    if (req.url?.startsWith('/api/users')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-source': 'live' });
      res.end(JSON.stringify({ users: ['ada'], url: req.url }));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    }
  });
  const { page, listenPort } = await startProxied(upstream.port);
  await fetchViaProxy(listenPort, '/api/users');
  await fetchViaProxy(listenPort, '/api/users?page=2');
  await fetchViaProxy(listenPort, '/missing');
  await expect(row(page, '/missing')).toContainText('404');

  // Narrow to the API calls, then record them in one click.
  await page.getByLabel('Filter traffic').fill('/api');
  await page.getByRole('button', { name: 'Record as mocks' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record as mocks' });
  await expect(dialog.getByLabel('The 2 requests the filter lists')).toBeChecked();
  const preview = dialog.getByLabel('Recording preview');
  await expect(preview).toContainText('2 new mocks');
  await expect(preview).toContainText('URL is exactly "/api/users?page=2"');
  await expect(dialog).toContainText('They answer at once.');
  if (process.env['CAPTURE_SCREENSHOTS']) {
    await page.screenshot({ path: 'docs/screenshots/record-mocks.png' });
  }
  await dialog.getByRole('button', { name: 'Record 2 mocks' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/Recorded 2 new mocks/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Routes and mocks/ })).toHaveAccessibleName(
    'Routes and mocks, 2 active'
  );

  // The upstream goes away; the recorded responses are still served.
  await upstream.close();
  const hits = upstream.requests.length;
  const users = await fetchViaProxy(listenPort, '/api/users');
  expect(users.statusCode).toBe(200);
  expect(users.headers['content-type']).toBe('application/json');
  expect(users.headers['x-source']).toBe('live');
  expect(JSON.parse(users.body)).toEqual({ users: ['ada'], url: '/api/users' });
  const page2 = await fetchViaProxy(listenPort, '/api/users?page=2');
  expect(JSON.parse(page2.body)).toEqual({ users: ['ada'], url: '/api/users?page=2' });
  expect(upstream.requests).toHaveLength(hits);
  await page.getByLabel('Filter traffic').fill('');
  await expect(row(page, 'MOCK')).toHaveCount(2);

  // The recordings are ordinary mocks: listed, named, and editable.
  await page.getByRole('button', { name: /Routes and mocks/ }).click();
  const rules = page.getByRole('dialog', { name: 'Routes and mocks' });
  await expect(rules.getByLabel('Mock 1 name')).toHaveValue('Recorded: GET /api/users?page=2');
  await expect(rules.getByLabel('Mock 2 name')).toHaveValue('Recorded: GET /api/users');
});

test('a response breakpoint holds the response until it is edited and continued', async () => {
  const upstream = await upstreamOf((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"paid":true}');
  });
  const { page, listenPort } = await startProxied(upstream.port);

  await page.getByRole('button', { name: /Breakpoints/ }).click();
  await page.getByLabel('Hold').selectOption('response');
  await page.getByLabel('URL path regex').fill('/pay');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'response', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  let settled = false;
  const pending = fetchViaProxy(listenPort, '/pay').then((r) => {
    settled = true;
    return r;
  });
  const held = page.getByRole('region', { name: 'Held response' });
  await expect(held).toBeVisible();
  // The upstream has answered, but the client is still waiting.
  expect(upstream.requests).toHaveLength(1);
  expect(settled).toBe(false);
  await expect(held).toContainText('response to GET /pay');

  await held.getByLabel('Status code').fill('402');
  await held.getByText('Headers (').click();
  await held.getByLabel('Response body').fill('{"paid":false,"reason":"edited"}');
  await held.getByRole('button', { name: 'Continue' }).click();

  const res = await pending;
  expect(res.statusCode).toBe(402);
  expect(res.body).toBe('{"paid":false,"reason":"edited"}');
  await expect(held).toHaveCount(0);
  await expect(row(page, '/pay')).toContainText('402');
});

test('replay from the context menu, and edit-and-replay', async () => {
  const upstream = await upstreamOf((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${req.method} ${req.url} tag=${req.headers['x-tag'] ?? 'none'}`);
  });
  const { page, listenPort } = await startProxied(upstream.port);
  await fetchViaProxy(listenPort, '/orders/1', { headers: { 'x-tag': 'original' } });
  await expect(row(page, '/orders/1')).toHaveCount(1);

  await row(page, '/orders/1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Replay', exact: true }).click();
  await expect(row(page, '/orders/1')).toHaveCount(2);
  expect(upstream.requests).toHaveLength(2);
  expect(upstream.requests[1].headers['x-tag']).toBe('original');
  // The replayed entry is marked and selected.
  await expect(page.locator('tr[aria-selected="true"]')).toContainText('↺');
  await expect(page.getByLabel('Request summary')).toContainText('replayed');

  await row(page, '/orders/1').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit and Replay…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit and replay' });
  await dialog.getByLabel('Replay method').fill('DELETE');
  await dialog.getByLabel('Replay URL').fill('/orders/2');
  const headers = dialog.getByLabel(/^Headers/);
  await headers.fill((await headers.inputValue()).replace('x-tag: original', 'x-tag: edited'));
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect(row(page, '/orders/2')).toContainText('200');
  expect(upstream.requests[2]).toMatchObject({ method: 'DELETE', url: '/orders/2' });
  expect(upstream.requests[2].headers['x-tag']).toBe('edited');
  await expect(page.getByText('DELETE /orders/2 tag=edited').first()).toBeVisible({
    timeout: 15_000,
  });
});

test('HAR export writes a valid archive and import loads it back', async () => {
  const upstream = await upstreamOf((req, res) => {
    res.writeHead(req.url === '/fail' ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  });
  const { page, listenPort } = await startProxied(upstream.port);
  await fetchViaProxy(listenPort, '/one?x=1', { method: 'POST', body: 'payload' });
  await fetchViaProxy(listenPort, '/fail');
  await expect(row(page, '/fail')).toBeVisible();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-har-'));
  const file = path.join(dir, 'session.har');
  await launched!.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
  }, file);

  await page.getByRole('button', { name: 'Export HAR' }).click();
  await expect(page.getByRole('status')).toContainText(`Exported 2 requests to ${file}`);
  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(har.log.version).toBe('1.2');
  expect(har.log.creator.name).toBe('Reversee');
  expect(har.log.entries).toHaveLength(2);
  expect(har.log.entries[0].request).toMatchObject({
    method: 'POST',
    url: `http://127.0.0.1:${upstream.port}/one?x=1`,
    queryString: [{ name: 'x', value: '1' }],
    postData: { text: 'payload' },
  });
  expect(har.log.entries[0].response.content.text).toBe('{"path":"/one?x=1"}');
  expect(har.log.entries[1].response.status).toBe(500);
  expect(har.log.entries[0].time).toBeGreaterThan(0);

  // Filtered export from the File menu path: only the failures.
  await page.getByRole('button', { name: 'Errors' }).click();
  await page.getByRole('button', { name: 'Export HAR' }).click();
  await expect(page.getByRole('status')).toContainText('Exported 1 request to');
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).log.entries).toHaveLength(1);
  await page.getByRole('button', { name: 'Errors' }).click();

  // Write the full session again, clear, and import it via the menu.
  await page.getByRole('button', { name: 'Export HAR' }).click();
  await expect(page.getByRole('status')).toContainText('Exported 2 requests');
  await clickMenu(['Proxy', 'Clear Traffic']);
  await expect(page.getByText(/No traffic yet/)).toBeVisible();
  await clickMenu(['File', 'Import HAR…']);
  await expect(row(page, '/one?x=1')).toContainText('HAR');
  await expect(row(page, '/fail')).toContainText('500');
  await row(page, '/one?x=1').click();
  await expect(page.getByLabel('Request summary')).toContainText('imported from HAR');
  await expect(page.getByText('"path"').first()).toBeVisible({ timeout: 15_000 });

  // A file that is not a HAR is reported, not swallowed.
  fs.writeFileSync(file, '{"not":"a har"}');
  await page.getByRole('button', { name: 'Import HAR' }).click();
  await expect(page.getByRole('status')).toContainText('not a HAR file');
});

test('sorting, keyboard navigation and menu shortcuts', async () => {
  const upstream = await upstreamOf((req, res) => {
    const delay = req.url === '/slow' ? 300 : 0;
    setTimeout(() => res.end(req.url === '/big' ? 'x'.repeat(5000) : 'ok'), delay);
  });
  const { page, listenPort } = await startProxied(upstream.port);
  for (const p of ['/slow', '/big', '/tiny']) await fetchViaProxy(listenPort, p);
  await expect(row(page, '/tiny')).toBeVisible();
  expect(await shownIds(page)).toEqual([1, 2, 3]);
  await expect(row(page, '/big')).toContainText('5.0 kB');

  await page.getByRole('button', { name: 'Time', exact: true }).click();
  expect((await shownIds(page))[0]).toBe(1); // slowest first
  await page.getByRole('button', { name: 'Size', exact: true }).click();
  expect((await shownIds(page))[0]).toBe(2); // biggest first
  await page.getByRole('button', { name: 'Path', exact: true }).click();
  expect(await shownIds(page)).toEqual([2, 1, 3]); // /big /slow /tiny
  await page.getByRole('button', { name: '#', exact: true }).click();
  expect(await shownIds(page)).toEqual([1, 2, 3]);

  // Arrow keys move the selection and the detail pane follows.
  await page.getByRole('region', { name: 'Captured traffic' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByLabel('Request summary')).toContainText('/slow');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByLabel('Request summary')).toContainText('/big');
  await page.keyboard.press('End');
  await expect(page.getByLabel('Request summary')).toContainText('/tiny');
  await page.keyboard.press('Home');
  await expect(page.getByLabel('Request summary')).toContainText('/slow');

  // Menu: focus the filter, type, Escape clears.
  await clickMenu(['Proxy', 'Filter Traffic']);
  await expect(page.getByLabel('Filter traffic')).toBeFocused();
  await page.keyboard.type('tiny');
  await expect(page.getByText('1 of 3')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Filter traffic')).toHaveValue('');

  // Menu: stop / start the proxy, clear the table.
  await clickMenu(['Proxy', 'Start / Stop Proxy']);
  await expect(page.getByText('Proxy stopped')).toBeVisible();
  await clickMenu(['Proxy', 'Start / Stop Proxy']);
  await expect(page.getByText(/Proxy running/)).toBeVisible();
  await clickMenu(['Proxy', 'Clear Traffic']);
  await expect(page.getByText(/No traffic yet/)).toBeVisible();

  // Menu: the new dialogs.
  await clickMenu(['File', 'Preferences…']);
  await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible();
  await page.keyboard.press('Escape');
  await clickMenu(['Proxy', 'Routes && Mocks…']);
  await expect(page.getByRole('dialog', { name: 'Routes and mocks' })).toBeVisible();
});

test('the table stays light with thousands of rows and honours the history size', async () => {
  const upstream = await upstreamOf((_req, res) => res.end('ok'));
  const { page, listenPort } = await startProxied(upstream.port, { trafficCap: 100 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  closers.push(async () => agent.destroy());
  const get = (i: number) =>
    new Promise<void>((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port: listenPort, path: `/n/${i}`, agent }, (res) => {
          res.resume();
          res.on('end', resolve);
        })
        .on('error', reject);
    });
  for (let batch = 0; batch < 13; batch++) {
    await Promise.all(Array.from({ length: 10 }, (_, i) => get(batch * 10 + i)));
  }
  // 130 sent, 100 kept (the oldest evicted) — in main and in the window.
  await expect(page.getByLabel('Request count')).toHaveText('100 requests');
  const ids = await shownIds(page);
  expect(Math.min(...ids)).toBeGreaterThanOrEqual(31);
  // Only the rows near the viewport are in the DOM.
  expect(ids.length).toBeLessThan(100);

  // Raising the cap in Preferences applies without a restart.
  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByLabel('History size').fill('150');
  await page.keyboard.press('Escape');
  for (let i = 0; i < 30; i++) await get(1000 + i);
  await expect(page.getByLabel('Request count')).toHaveText('130 requests');
});

test('dark theme: follows the setting, restyles the app and the editor', async () => {
  const upstream = await upstreamOf((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"theme":"check"}');
  });
  const { page, listenPort } = await startProxied(upstream.port, { theme: 'light' });
  // Playwright pins pages to a light colour scheme by default; drop that so
  // the page follows the app (nativeTheme), as it does for real users.
  await page.emulateMedia({ colorScheme: null });
  await fetchViaProxy(listenPort, '/themed');
  await row(page, '/themed').click();
  await expect(page.getByText('"theme"').first()).toBeVisible({ timeout: 15_000 });

  const lightness = (selector: string) =>
    page.evaluate((selector) => {
      const el = document.querySelector(selector) as HTMLElement;
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return (r + g + b) / 3;
    }, selector);

  expect(await lightness('[aria-label="Captured traffic"]')).toBeGreaterThan(240);
  expect(await lightness('.monaco-editor')).toBeGreaterThan(240);

  await page.getByRole('button', { name: 'Preferences' }).click();
  await page.getByLabel('Theme').selectOption('dark');
  await page.keyboard.press('Escape');

  await expect.poll(() => lightness('[aria-label="Captured traffic"]')).toBeLessThan(70);
  await expect.poll(() => lightness('.monaco-editor')).toBeLessThan(70);
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  // Native chrome follows too.
  expect(await launched!.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(
    true
  );
  // Text stays readable: it flips to light on the dark surface.
  const textLightness = await page.evaluate(() => {
    const cell = document.querySelector('tr[data-traffic-id] td:nth-child(4)') as HTMLElement;
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.fillStyle = getComputedStyle(cell).color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return (r + g + b) / 3;
  });
  expect(textLightness).toBeGreaterThan(180);
  if (process.env['CAPTURE_SCREENSHOTS']) {
    await page.screenshot({ path: 'docs/screenshots/dark-mode.png' });
  }
});

/** A self-signed root CA whose validity ended `daysAgo` days ago, in the stored layout. */
function expiredRoot(daysAgo: number): {
  privateKey: string;
  publicKey: string;
  certificate: string;
} {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  const day = 24 * 60 * 60 * 1000;
  cert.validity.notBefore = new Date(Date.now() - (daysAgo + 365) * day);
  cert.validity.notAfter = new Date(Date.now() - daysAgo * day);
  const subject = [{ name: 'commonName', value: 'reversee.ninja' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    privateKey: forge.pki.privateKeyToPem(keys.privateKey),
    publicKey: forge.pki.publicKeyToPem(keys.publicKey),
    certificate: forge.pki.certificateToPem(cert),
  };
}

function getTrusting(port: number, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get({ host: '127.0.0.1', port, path: '/tls', ca, rejectUnauthorized: true }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

test('an expired root certificate is flagged and can be regenerated in place', async () => {
  const upstream = await upstreamOf((_req, res) => res.end('secure upstream'));
  const old = expiredRoot(40);
  const { page, listenPort } = await startProxied(
    upstream.port,
    { listenProtocol: 'https' },
    // electron-store keys are dot paths: 'root.cert.pem' is stored nested.
    { root: { cert: { pem: old } } }
  );
  const configPath = path.join(launched!.userDataDir, 'config.json');
  const storedRoot = (): string =>
    JSON.parse(fs.readFileSync(configPath, 'utf8')).root.cert.pem.certificate;

  // The stored root is kept (not silently replaced) and the problem is shown.
  expect(storedRoot()).toBe(old.certificate);
  const banner = page.getByRole('alert', { name: 'Root certificate warning' });
  await expect(banner).toContainText(/The root certificate expired on \d{4}-\d{2}-\d{2}/);
  // A client that trusts that root still rejects the listener: it is expired.
  await expect(getTrusting(listenPort, old.certificate)).rejects.toThrow(/expired/i);

  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByLabel('Root certificate status')).toContainText('Expired on');
  await page.keyboard.press('Escape');

  // Declining the confirmation changes nothing.
  await launched!.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
  });
  await banner.getByRole('button', { name: 'Regenerate…' }).click();
  await expect(banner).toBeVisible();
  expect(storedRoot()).toBe(old.certificate);

  await launched!.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
  });
  await banner.getByRole('button', { name: 'Regenerate…' }).click();
  await expect(banner).toHaveCount(0);

  const fresh = storedRoot();
  expect(fresh).not.toBe(old.certificate);
  // The running HTTPS listener was restarted onto a certificate from the new
  // root: a client trusting only that root connects by IP address.
  await expect(async () => {
    expect(await getTrusting(listenPort, fresh)).toBe('secure upstream');
  }).toPass({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByLabel('Root certificate status')).toContainText(
    /Valid until .* days left/
  );
});

test('no certificate warning for a healthy root, or when not listening on https', async () => {
  const upstream = await upstreamOf();
  const { page } = await startProxied(upstream.port, { listenProtocol: 'https' });
  await expect(page.getByRole('alert', { name: 'Root certificate warning' })).toHaveCount(0);
  const status = await page.evaluate(() => window.reversee.getCertStatus());
  expect(status.expired).toBe(false);
  expect(status.daysLeft).toBeGreaterThan(3600); // new roots are long-lived
});

test('interceptor failures are visible, and a runaway interceptor cannot wedge the proxy', async () => {
  const upstream = await upstreamOf((_req, res) => res.end('upstream body'));
  const { page, listenPort } = await startProxied(upstream.port, {
    interceptRequest: true,
    requestInterceptor:
      "console.log('saw', requestParams.path); if (requestParams.path === '/spin') { while (true) {} }",
    interceptResponse: true,
    responseInterceptor: 'responseParams.body = missingVariable',
  });

  const res = await fetchViaProxy(listenPort, '/ok');
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('upstream body'); // the broken interceptor did not break the response

  // The toolbar button flags the failure, and the Scripts screen names it.
  const scripts = page.getByRole('button', { name: /^Scripts/ });
  await expect(scripts).toHaveAccessibleName('Scripts, 2 on, last run failed');
  await scripts.click();
  await page.getByRole('tab', { name: /Response script/ }).click();
  await expect(page.getByText(/last run failed: missingVariable is not defined/)).toBeVisible();
  await page.keyboard.press('Escape');
  await row(page, '/ok').click();
  await page.getByRole('tab', { name: /Interceptor/ }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'response interceptor error' })
  ).toContainText('missingVariable is not defined');
  await expect(page.getByText('saw /ok')).toBeVisible();

  // An infinite loop is cut off at the time budget; the proxy keeps serving.
  const started = Date.now();
  expect((await fetchViaProxy(listenPort, '/spin')).statusCode).toBe(200);
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(scripts).toHaveAttribute(
    'title',
    'A script failed on the last request: interceptor timed out after 1000 ms'
  );
  // The next request runs the request script normally; only the response one still fails.
  expect((await fetchViaProxy(listenPort, '/after')).statusCode).toBe(200);
  await expect(scripts).toHaveAttribute(
    'title',
    'A script failed on the last request: missingVariable is not defined'
  );
});

test('the Scripts screen: try a script on a captured request, then apply it while running', async () => {
  const upstream = await upstreamOf((req, res) => res.end(`tag=${req.headers['x-tag'] ?? '-'}`));
  const { page, listenPort } = await startProxied(upstream.port);
  expect((await fetchViaProxy(listenPort, '/first')).body).toBe('tag=-');
  await expect(row(page, '/first')).toBeVisible();

  const scripts = page.getByRole('button', { name: /^Scripts/ });
  await expect(scripts).toHaveAccessibleName('Scripts');
  await scripts.click();
  const dialog = page.getByRole('dialog', { name: 'Scripts' });
  await expect(dialog.getByText('requestParams.headers', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/applies the scripts to the running proxy at once/)).toBeVisible();

  // Editable although the proxy is running.
  const editor = dialog.locator('.monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type("requestParams.headers['x-tag'] = 'scripted'; console.log('ran');");

  // Dry run: reports the change, sends nothing.
  const sent = upstream.requests.length;
  await dialog.getByRole('button', { name: 'Try it' }).click();
  const result = dialog.getByLabel('Try it result');
  await expect(result).toContainText('made 1 change');
  await expect(result).toContainText('header x-tag added: scripted');
  await expect(result).toContainText('ran');
  expect(upstream.requests).toHaveLength(sent);

  await dialog.getByLabel('Run on every request').check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(scripts).toHaveAccessibleName('Scripts, 1 on');
  await expect(page.getByText(/Proxy running/)).toBeVisible();
  await expect
    .poll(async () => (await fetchViaProxy(listenPort, '/second')).body)
    .toBe('tag=scripted');

  // An example from the side panel, for the response this time.
  await scripts.click();
  await dialog.getByRole('tab', { name: /Response script/ }).click();
  await dialog.getByRole('button', { name: 'Change the status' }).click();
  await dialog.getByLabel('Run on every response').check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(scripts).toHaveAccessibleName('Scripts, 2 on');
  await expect.poll(async () => (await fetchViaProxy(listenPort, '/third')).statusCode).toBe(503);
});

test('a hung upstream times out with a 504 that explains itself', async () => {
  const upstream = await upstreamOf(() => {
    /* never answers */
  });
  const { page, listenPort } = await startProxied(upstream.port, { upstreamTimeoutSec: 1 });
  const res = await fetchViaProxy(listenPort, '/hang');
  expect(res.statusCode).toBe(504);
  expect(res.headers['x-reversee-error']).toBe('ETIMEDOUT');
  expect(res.body).toContain('no response from the upstream within 1 s');

  const hang = row(page, '/hang');
  await expect(hang).toContainText('ERR');
  await hang.click();
  await expect(page.getByLabel('Request summary')).toContainText('no response from the upstream');
});

test('an unreachable upstream produces a descriptive 502', async () => {
  const dead = await freePort();
  const { listenPort } = await startProxied(dead);
  const res = await fetchViaProxy(listenPort, '/nobody-home');
  expect(res.statusCode).toBe(502);
  expect(res.headers['x-reversee-error']).toBe('ECONNREFUSED');
  expect(res.body).toContain(`http://127.0.0.1:${dead}/nobody-home`);
});

test('gRPC mode still serves HTTP/1.1 clients on the same port', async () => {
  const upstream = await upstreamOf((req, res) => res.end(`http/${req.httpVersion}`));
  const { page, listenPort } = await startProxied(upstream.port, { enableGrpc: true });
  const res = await fetchViaProxy(listenPort, '/plain-in-grpc-mode');
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('http/1.1');
  await expect(row(page, '/plain-in-grpc-mode')).toContainText('200');
});

test('mutual TLS: the client certificate chosen in Preferences reaches the upstream', async () => {
  // A throwaway CA, a server cert and a client cert signed by it.
  const make = (
    cn: string,
    issuer?: { subject: forge.pki.CertificateField[]; key: forge.pki.PrivateKey },
    extensions: object[] = []
  ) => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = String(Math.floor(Math.random() * 1e9) + 1);
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + 3_600_000);
    const subject = [{ name: 'commonName', value: cn }];
    cert.setSubject(subject);
    cert.setIssuer(issuer?.subject ?? subject);
    cert.setExtensions(extensions);
    cert.sign(issuer?.key ?? keys.privateKey, forge.md.sha256.create());
    return {
      subject,
      key: keys.privateKey,
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
  };
  const ca = make('E2E mTLS CA', undefined, [{ name: 'basicConstraints', cA: true }]);
  const server = make('localhost', ca, [
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
  ]);
  const client = make('e2e-client', ca, [{ name: 'extKeyUsage', clientAuth: true }]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-mtls-'));
  const certFile = path.join(dir, 'client.pem');
  const keyFile = path.join(dir, 'client.key');
  fs.writeFileSync(certFile, client.certPem);
  fs.writeFileSync(keyFile, client.keyPem);

  const mtls = https.createServer(
    {
      key: server.keyPem,
      cert: server.certPem,
      ca: ca.certPem,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) =>
      res.end(
        `hello ${(req.socket as import('node:tls').TLSSocket).getPeerCertificate().subject.CN}`
      )
  );
  await new Promise<void>((r) => mtls.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise((r) => {
        mtls.closeAllConnections();
        mtls.close(r);
      })
  );
  const mtlsPort = (mtls.address() as { port: number }).port;

  const listenPort = await freePort();
  launched = await launchApp({
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'https',
      destPort: mtlsPort,
      listenProtocol: 'http',
      listenPort,
    },
  });
  const { page } = launched;

  // Without a client certificate the upstream refuses the handshake.
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(/Proxy running/)).toBeVisible();
  expect((await fetchViaProxy(listenPort, '/secure')).statusCode).toBe(502);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Proxy stopped')).toBeVisible();

  // Pick the files through the (stubbed) native picker.
  await page.getByRole('button', { name: 'Preferences' }).click();
  const prefs = page.getByRole('dialog', { name: 'Preferences' });
  const pick = async (index: number, file: string) => {
    await launched!.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
    }, file);
    await prefs.getByRole('button', { name: 'Browse…' }).nth(index).click();
  };
  await pick(0, certFile);
  await expect(prefs.getByLabel('Certificate file')).toHaveValue(certFile);
  // A half-configured pair is refused with a clear message instead of a TLS error.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'both a certificate file and a key file are required'
  );
  await page.getByRole('button', { name: 'Dismiss error' }).click();

  await page.getByRole('button', { name: 'Preferences' }).click();
  await pick(1, keyFile);
  await expect(prefs.getByLabel('Key file')).toHaveValue(keyFile);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(/Proxy running/)).toBeVisible();
  const res = await fetchViaProxy(listenPort, '/secure');
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('hello e2e-client');
});

test('capture anything: the app works as an HTTP/HTTPS proxy for any server', async () => {
  const plain = await upstreamOf((_req, res) => res.end('plain server'));
  const secure = await upstreamOf(
    (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"from":"secure server"}');
    },
    { tls: true }
  );
  const listenPort = await freePort();
  // No destination at all; the fixture's HTTPS server is self-signed.
  launched = await launchApp({ settings: { dest: '', listenPort, captureVerifyUpstream: false } });
  const { page } = launched;

  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  await page.getByLabel('Mode').selectOption('capture');
  await expect(page.getByLabel('Destination host')).toHaveCount(0);
  await page.getByRole('button', { name: 'How to connect' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    `HTTPS_PROXY=http://127.0.0.1:${listenPort}`
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(`Proxy running on port ${listenPort}`)).toBeVisible();

  // Plain HTTP: an absolute-form request, as a proxy client sends it.
  const viaProxy = await new Promise<string>((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port: listenPort, path: `http://127.0.0.1:${plain.port}/hello` },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve(text));
        }
      )
      .on('error', reject);
  });
  expect(viaProxy).toBe('plain server');
  expect(plain.requests[0].url).toBe('/hello');

  // HTTPS: CONNECT, then TLS that trusts only the Reversee root.
  const root = JSON.parse(fs.readFileSync(path.join(launched.userDataDir, 'config.json'), 'utf8'))
    .root.cert.pem.certificate as string;
  const tunnel = await new Promise<import('node:net').Socket>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: listenPort,
      method: 'CONNECT',
      path: `127.0.0.1:${secure.port}`,
    });
    req.on('connect', (res, socket) =>
      res.statusCode === 200 ? resolve(socket) : reject(new Error(`CONNECT ${res.statusCode}`))
    );
    req.on('error', reject);
    req.end();
  });
  const body = await new Promise<string>((resolve, reject) => {
    const agent = new https.Agent();
    (agent as unknown as { createConnection: () => tls.TLSSocket }).createConnection = () =>
      tls.connect({ socket: tunnel, host: '127.0.0.1', ca: root });
    https
      .get({ agent, host: '127.0.0.1', path: '/account?id=1' }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(text));
      })
      .on('error', reject);
  });
  tunnel.destroy();
  expect(body).toBe('{"from":"secure server"}');
  expect(secure.requests[0].url).toBe('/account?id=1');

  // Both show up, each under the server it went to.
  await expect(row(page, '/hello')).toContainText(`127.0.0.1:${plain.port}`);
  await expect(row(page, '/account?id=1')).toContainText(`127.0.0.1:${secure.port}`);
  if (process.env['CAPTURE_SCREENSHOTS']) {
    await page.screenshot({ path: 'docs/screenshots/capture-anything.png' });
  }
  await page.getByLabel('Filter traffic').fill(String(secure.port));
  await expect(page.locator('tr[data-traffic-id]')).toHaveCount(1);
});
