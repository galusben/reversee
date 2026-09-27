// The bundled Monaco editor (workers under the CSP, formatting, editing) and
// the clipboard IPC path, through the real built app. Clipboard is read back
// in main — that is the API Electron reworked in 44.
import { test, expect } from '@playwright/test';
import {
  launchApp,
  startUpstream,
  fetchViaProxy,
  freePort,
  type LaunchedApp,
  type Upstream,
} from './fixtures/launch';

let launched: LaunchedApp | null = null;
let upstream: Upstream | null = null;

test.afterEach(async () => {
  const rendererErrors = launched?.rendererErrors ?? [];
  await launched?.close().catch(() => {});
  await upstream?.close().catch(() => {});
  launched = null;
  upstream = null;
  expect(rendererErrors, 'renderer console errors / uncaught exceptions').toEqual([]);
});

const JSON_BODY = '{"user":{"id":7,"roles":["admin","dev"]},"ok":true}';

async function launchWithJsonTraffic(): Promise<LaunchedApp> {
  upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON_BODY);
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
  await fetchViaProxy(listenPort, '/api/profile', { headers: { 'x-trace': 'abc' } });
  await page.getByRole('row').filter({ hasText: '/api/profile' }).click();
  return launched;
}

const readClipboard = (app: LaunchedApp['app']) =>
  app.evaluate(({ clipboard }) => clipboard.readText());

const lineCount = (page: LaunchedApp['page']) =>
  page.locator('.monaco-editor').first().locator('.view-line').count();

test('Monaco renders the body and formats JSON through its language worker', async () => {
  const { page } = await launchWithJsonTraffic();
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // Plain view: the body is one line.
  await expect(editor.locator('.view-line')).toHaveCount(1);
  await expect(editor).toContainText('"roles"');

  // Load the JSON language mode, then format with it (see the known bug below
  // for why the first toggle alone is not enough).
  await page.getByRole('button', { name: 'Formatted' }).click();
  await page.getByRole('button', { name: 'Plain' }).click();
  await page.getByRole('button', { name: 'Formatted' }).click();
  await expect.poll(() => lineCount(page), { timeout: 15_000 }).toBeGreaterThan(5);
  const formatted = page.locator('.monaco-editor').first();
  await expect(formatted).toContainText('"admin",');
  // The formatter runs in the bundled JSON worker, loaded under the CSP.
  expect(page.workers().map((w) => w.url())).toContainEqual(expect.stringMatching(/json\.worker/));
  // Distinct token classes = the json tokenizer is active.
  const classes = await formatted
    .locator('.view-line span[class*="mtk"]')
    .evaluateAll((els) => new Set(els.map((e) => e.className.split(' ')[0])).size);
  expect(classes).toBeGreaterThan(2);
});

// KNOWN BUG (pre-existing, found while adding this suite): the first
// "Formatted" click in a session shows the body unformatted. MonacoViewImpl
// runs formatDocument on mount, before Monaco has lazily loaded the JSON mode
// that registers the formatter. test.fail() keeps this documented; it will
// start "unexpectedly passing" once fixed — then drop the annotation.
test('the first Formatted click formats the body', async () => {
  test.fail();
  const { page } = await launchWithJsonTraffic();
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Formatted' }).click();
  await expect.poll(() => lineCount(page), { timeout: 5_000 }).toBeGreaterThan(5);
});

test('copying writes to the system clipboard', async () => {
  const { app, page } = await launchWithJsonTraffic();

  // Body "Copy" button.
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => readClipboard(app)).toBe(JSON_BODY);

  // Headers pane context menu.
  await page.getByRole('tab', { name: 'Request Headers' }).click();
  await page.getByText(/x-trace : abc/).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy To Clipboard' }).click();
  await expect.poll(() => readClipboard(app)).toContain('x-trace : abc');

  // Traffic row context menu: copy as curl.
  await page.getByRole('row').filter({ hasText: '/api/profile' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy as curl' }).click();
  await expect.poll(() => readClipboard(app)).toMatch(/^curl .*\/api\/profile/s);

  // Connect AI setup snippet.
  await page.getByRole('button', { name: /Connect AI/ }).click();
  await page.getByRole('button', { name: 'Copy Claude Code' }).click();
  await expect
    .poll(() => readClipboard(app))
    .toBe('claude mcp add reversee -- npx -y reversee-mcp');
});

test('the clipboard IPC ignores non-string payloads', async () => {
  launched = await launchApp();
  const { app, page } = launched;
  await app.evaluate(({ clipboard }) => clipboard.writeText('unchanged'));
  await page.evaluate(() =>
    (window.reversee.copyToClipboard as (v: unknown) => Promise<void>)({ not: 'a string' })
  );
  expect(await readClipboard(app)).toBe('unchanged');
});

test('interceptor code edited in Monaco is saved to settings', async () => {
  launched = await launchApp();
  const { page } = launched;
  await page
    .getByRole('button', { name: /show editor/ })
    .first()
    .click();
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 15_000 });

  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type("requestParams.headers['x-e2e'] = 'typed';");

  await expect
    .poll(() =>
      page.evaluate(() => window.reversee.getSettings().then((s) => s.requestInterceptor))
    )
    .toBe("requestParams.headers['x-e2e'] = 'typed';");
});
