// End-to-end flows through the real packaged-layout app (out/ build).
import { test, expect } from '@playwright/test';
import {
  launchApp,
  startUpstream,
  fetchViaProxy,
  freePort,
  occupyPort,
  type LaunchedApp,
  type Upstream,
} from './fixtures/launch';

let launched: LaunchedApp | null = null;
let upstream: Upstream | null = null;

test.afterEach(async () => {
  await launched?.close().catch(() => {});
  await upstream?.close().catch(() => {});
  launched = null;
  upstream = null;
});

test('launches with a visible window and secure renderer', async () => {
  launched = await launchApp();
  const { page } = launched;
  await expect(page.getByText('Proxy stopped')).toBeVisible();
  // contextIsolation/sandbox: no node leakage into the page.
  expect(await page.evaluate(() => typeof (window as never)['require'])).toBe('undefined');
  expect(await page.evaluate(() => typeof (window as never)['process'])).toBe('undefined');
});

test('proxies a request and shows it in the table with details', async () => {
  upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"hello":"world"}');
  });
  const listenPort = await freePort();
  launched = await launchApp({
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort: upstream.port,
      listenProtocol: 'http',
      listenPort,
    },
  });
  const { page } = launched;

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(`Proxy running on port ${listenPort}`)).toBeVisible();

  const res = await fetchViaProxy(listenPort, '/api/hello');
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('{"hello":"world"}');

  const row = page.getByRole('row').filter({ hasText: '/api/hello' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('200');
  await expect(row).toContainText('application/json');

  // Inspect details.
  await row.click();
  await expect(page.getByText('"hello"').first()).toBeVisible({ timeout: 15000 });
  await page.getByRole('tab', { name: 'Response Headers' }).click();
  await expect(page.getByText('content-type : application/json')).toBeVisible();
  await page.getByRole('tab', { name: 'Timings' }).click();
  await expect(page.getByText(/Total : .* ms/)).toBeVisible();

  // Stop.
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Proxy stopped')).toBeVisible();
});

test('request and response interceptors round-trip', async () => {
  upstream = await startUpstream((req, res) => {
    res.writeHead(200, { echoed: String(req.headers['x-added'] ?? '') });
    res.end('original body');
  });
  const listenPort = await freePort();
  launched = await launchApp({
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort: upstream.port,
      listenProtocol: 'http',
      listenPort,
      interceptRequest: true,
      requestInterceptor: "requestParams.headers['x-added']='from-interceptor'",
      interceptResponse: true,
      responseInterceptor: "responseParams.body='intercepted: ' + requestParams.path",
    },
  });
  const { page } = launched;
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(/Proxy running/)).toBeVisible();

  const res = await fetchViaProxy(listenPort, '/echo');
  expect(res.headers['echoed']).toBe('from-interceptor');
  expect(res.body).toBe('intercepted: /echo');
});

test('breakpoint holds a request, edits flow to the upstream', async () => {
  upstream = await startUpstream();
  const listenPort = await freePort();
  launched = await launchApp({
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort: upstream.port,
      listenProtocol: 'http',
      listenPort,
    },
  });
  const { page } = launched;

  // Define a breakpoint via the dialog.
  await page.getByRole('button', { name: /Breakpoints/ }).click();
  await page.getByLabel('URL path regex').fill('/held');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('cell', { name: '/held', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(/Proxy running/)).toBeVisible();

  const pending = fetchViaProxy(listenPort, '/held');
  // The request is held: the queue panel appears, upstream has seen nothing.
  await expect(page.getByRole('region', { name: 'Held request' })).toBeVisible();
  expect(upstream.requests).toHaveLength(0);

  // Edit the URL and add a header, then continue.
  await page.getByLabel('URL', { exact: true }).fill('/edited-by-breakpoint');
  await page.getByText('Headers (').click();
  await page.getByText('+ add header').click();
  const lastRow = page.getByLabel(/Header \d+ name/).last();
  await lastRow.fill('x-breakpoint');
  await page.getByLabel(/Header \d+ value/).last().fill('edited');
  await page.getByRole('button', { name: 'Continue' }).click();

  const res = await pending;
  expect(res.statusCode).toBe(200);
  expect(upstream.requests).toHaveLength(1);
  expect(upstream.requests[0].url).toBe('/edited-by-breakpoint');
  expect(upstream.requests[0].headers['x-breakpoint']).toBe('edited');
});

test('rejects invalid listen ports', async () => {
  launched = await launchApp({
    settings: { dest: 'example.com', listenPort: 8000 },
  });
  const { page } = launched;
  const portInput = page.getByLabel('Listen port');
  await portInput.fill('0');
  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  await portInput.fill('70000');
  await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled();
  await portInput.fill('8080');
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
});

test('settings persist across relaunch', async () => {
  launched = await launchApp();
  const { page, userDataDir } = launched;
  await page.getByLabel('Destination host').fill('persisted.example.com');
  await page.getByLabel('Destination port').fill('4443');
  // Debounce-free: settings commit on change; give IPC a beat.
  await expect(page.getByLabel('Destination host')).toHaveValue('persisted.example.com');
  await launched.close();

  launched = await launchApp({ userDataDir });
  await expect(launched.page.getByLabel('Destination host')).toHaveValue('persisted.example.com');
  await expect(launched.page.getByLabel('Destination port')).toHaveValue('4443');
});

test('serves https with the generated certificate', async () => {
  upstream = await startUpstream();
  const listenPort = await freePort();
  launched = await launchApp({
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort: upstream.port,
      listenProtocol: 'https',
      listenPort,
    },
  });
  const { page } = launched;
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(/Proxy running/)).toBeVisible();

  const res = await fetchViaProxy(listenPort, '/over-tls', { tls: true });
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('upstream response');
  await expect(page.getByRole('row').filter({ hasText: '/over-tls' })).toBeVisible();
});

test('shows an error when the listen port is taken', async () => {
  upstream = await startUpstream();
  // Occupy a port on all interfaces (the proxy listens unbound, so taking
  // only 127.0.0.1 would not collide), then try to listen on it.
  const blocker = await occupyPort();
  launched = await launchApp({
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort: upstream.port,
      listenProtocol: 'http',
      listenPort: blocker.port,
    },
  });
  const { page } = launched;
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('alert')).toContainText(/EADDRINUSE/);
  await expect(page.getByText('Proxy stopped')).toBeVisible();
  await blocker.close();
});
