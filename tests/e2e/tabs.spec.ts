// Tabs through the real built app: two proxies running at once on their own
// ports, traffic kept per tab, a request held in a background tab, a port
// clash between tabs, closing a running tab, and tabs restored on relaunch.
import { test, expect, type Page } from '@playwright/test';
import {
  launchApp,
  startUpstream,
  fetchViaProxy,
  freePort,
  type LaunchedApp,
  type Upstream,
} from './fixtures/launch';

let launched: LaunchedApp | null = null;
const closers: Array<() => Promise<unknown>> = [];

test.afterEach(async () => {
  const rendererErrors = launched?.rendererErrors ?? [];
  await launched?.close().catch(() => {});
  launched = null;
  for (const close of closers.splice(0)) await close().catch(() => {});
  expect(rendererErrors, 'renderer console errors / uncaught exceptions').toEqual([]);
});

async function upstreamOf(tag: string): Promise<Upstream> {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${tag} ${req.url}`);
  });
  closers.push(() => upstream.close());
  return upstream;
}

const row = (page: Page, text: string | RegExp) => page.getByRole('row').filter({ hasText: text });
// Both tabs point at 127.0.0.1, so the second is told apart with a suffix.
const firstTab = (page: Page) => page.getByRole('tab', { name: /^127\.0\.0\.1,/ });
const secondTab = (page: Page) => page.getByRole('tab', { name: /^127\.0\.0\.1 #2/ });

/** Answers the next native message box (e.g. "Close tab?") with the given button. */
function answerNextDialog(response: number): Promise<void> {
  return launched!.app.evaluate(({ dialog }, response) => {
    dialog.showMessageBox = (() =>
      Promise.resolve({ response, checkboxChecked: false })) as typeof dialog.showMessageBox;
  }, response);
}

async function configureNewTab(page: Page, listenPort: number, destPort: number): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click();
  await expect(page.getByRole('tab', { name: /^New tab/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await page.getByLabel('Listen port').fill(String(listenPort));
  await page.getByLabel('Destination protocol').selectOption('http');
  await page.getByLabel('Destination host').fill('127.0.0.1');
  await page.getByLabel('Destination port').fill(String(destPort));
}

test('two tabs proxy two tools at once, each with its own traffic', async () => {
  const a = await upstreamOf('A');
  const b = await upstreamOf('B');
  const [portA, portB] = [await freePort(), await freePort()];
  launched = await launchApp({
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort: a.port,
      listenProtocol: 'http',
      listenPort: portA,
    },
  });
  const { page } = launched;

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(`Proxy running on port ${portA}`)).toBeVisible();

  await configureNewTab(page, portB, b.port);
  await expect(secondTab(page)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(`Proxy running on port ${portB}`)).toBeVisible();
  await expect(page.getByLabel('Running tabs')).toHaveText('2 tabs running');

  expect((await fetchViaProxy(portA, '/from-a')).body).toBe('A /from-a');
  expect((await fetchViaProxy(portB, '/from-b')).body).toBe('B /from-b');

  // The shown tab lists only its own requests; the other tab's count updates in the strip.
  await expect(row(page, '/from-b')).toBeVisible();
  await expect(row(page, '/from-a')).toHaveCount(0);
  await expect(firstTab(page)).toContainText('1');

  await firstTab(page).click();
  await expect(row(page, '/from-a')).toBeVisible();
  await expect(row(page, '/from-b')).toHaveCount(0);
  await expect(page.getByText(`Proxy running on port ${portA}`)).toBeVisible();
  await expect(page.getByLabel('Destination port')).toHaveValue(String(a.port));
});

test('a request held in a background tab is flagged and can be resumed from there', async () => {
  const a = await upstreamOf('A');
  const b = await upstreamOf('B');
  const [portA, portB] = [await freePort(), await freePort()];
  launched = await launchApp({
    settings: { dest: '127.0.0.1', destProtocol: 'http', destPort: a.port, listenPort: portA },
  });
  const { page } = launched;
  await page.getByRole('button', { name: 'Start' }).click();
  await configureNewTab(page, portB, b.port);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(`Proxy running on port ${portB}`)).toBeVisible();

  // A request breakpoint on the second tab only.
  await page.getByRole('button', { name: /Breakpoints/ }).click();
  await page.getByLabel('URL path regex').fill('/hold');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.keyboard.press('Escape');

  await firstTab(page).click();
  await expect(page.getByRole('button', { name: /Breakpoints$/ })).toBeVisible();
  const pending = fetchViaProxy(portB, '/hold');
  // The first tab's own traffic is not held.
  expect((await fetchViaProxy(portA, '/hold')).body).toBe('A /hold');

  await expect(secondTab(page)).toHaveAccessibleName(/1 held at a breakpoint/);
  const notice = page.getByRole('status');
  await expect(notice).toContainText('is holding a request at a breakpoint');
  await notice.click();
  await expect(secondTab(page)).toHaveAttribute('aria-selected', 'true');

  const held = page.getByRole('region', { name: 'Held request' });
  await expect(held).toBeVisible();
  await held.getByRole('button', { name: 'Continue' }).click();
  expect((await pending).body).toBe('B /hold');
  await expect(secondTab(page)).not.toHaveAccessibleName(/held/);
});

test('a tab cannot start on a port another running tab uses', async () => {
  const a = await upstreamOf('A');
  const portA = await freePort();
  launched = await launchApp({
    settings: { dest: '127.0.0.1', destProtocol: 'http', destPort: a.port, listenPort: portA },
  });
  const { page } = launched;
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(`Proxy running on port ${portA}`)).toBeVisible();

  await configureNewTab(page, portA, a.port);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('alert')).toContainText(
    `Port ${portA} is already used by the tab "127.0.0.1" (t1)`
  );
  await expect(page.getByText('Proxy stopped')).toBeVisible();
});

test('closing a running tab asks first; tabs come back stopped after a relaunch', async () => {
  const a = await upstreamOf('A');
  const b = await upstreamOf('B');
  const [portA, portB] = [await freePort(), await freePort()];
  launched = await launchApp({
    settings: { dest: '127.0.0.1', destProtocol: 'http', destPort: a.port, listenPort: portA },
  });
  const { page, userDataDir } = launched;
  await configureNewTab(page, portB, b.port);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(`Proxy running on port ${portB}`)).toBeVisible();

  await answerNextDialog(1); // Cancel
  await page.getByRole('button', { name: 'Close 127.0.0.1 #2' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect((await fetchViaProxy(portB, '/still-up')).body).toBe('B /still-up');

  // A third tab, named by the user, to check names survive the relaunch.
  await page.getByRole('button', { name: 'New tab' }).click();
  await page.getByRole('tab', { name: /^New tab/ }).dblclick();
  await page.getByRole('textbox', { name: 'Tab name' }).fill('Scratch');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /^Scratch/ })).toBeVisible();

  await answerNextDialog(0); // Close Tab
  await page.getByRole('button', { name: 'Close 127.0.0.1 #2' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(fetchViaProxy(portB, '/gone')).rejects.toThrow();

  await launched.close();
  launched = await launchApp({ userDataDir });
  const relaunched = launched.page;
  await expect(relaunched.getByRole('tab')).toHaveCount(2);
  await expect(relaunched.getByRole('tab', { name: /^127\.0\.0\.1, stopped/ })).toBeVisible();
  await expect(relaunched.getByRole('tab', { name: /^Scratch, stopped/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
});
