// App-level behaviour owned by the main process: version reporting, window
// state persistence, the application menu wiring, and the single-instance
// lock.
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import {
  launchApp,
  startUpstream,
  fetchViaProxy,
  freePort,
  type LaunchedApp,
  type Upstream,
} from './fixtures/launch';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/** Clicks an application-menu item by its label path, e.g. ['Proxy Settings', 'Reset Cache']. */
function clickMenu(app: LaunchedApp['app'], labels: string[]): Promise<void> {
  return app.evaluate(({ Menu }, labels) => {
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

function menuChecked(app: LaunchedApp['app'], id: string): Promise<boolean | undefined> {
  return app.evaluate(
    ({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.checked,
    id
  );
}

test('the renderer reports the same version as main', async () => {
  launched = await launchApp();
  const { app, page } = launched;
  // Unpackaged (out/main/index.js) runs report Electron's own version; the
  // packaged smoke test (tests/smoke) pins the real app version.
  const mainVersion = await app.evaluate(({ app }) => app.getVersion());
  expect(mainVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(await page.evaluate(() => window.reversee.getVersion())).toBe(mainVersion);
});

test('window size and position persist across relaunch', async () => {
  launched = await launchApp();
  const { userDataDir } = launched;
  // Size the target from the display so small CI screens (1024 wide) don't
  // clamp it: a distinctive size well inside the work area.
  const target = await launched.app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = {
      x: area.x + 40,
      y: area.y + 30,
      width: Math.min(900, area.width - 120),
      height: Math.min(600, area.height - 100),
    };
    BrowserWindow.getAllWindows()[0].setBounds(bounds);
    return BrowserWindow.getAllWindows()[0].getBounds();
  });
  await launched.close();

  launched = await launchApp({ userDataDir });
  const bounds = await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds()
  );
  expect(bounds.width).toBe(target.width);
  expect(bounds.height).toBe(target.height);
  // The window manager may nudge the position (menu bar, display edges).
  expect(Math.abs(bounds.x - target.x)).toBeLessThanOrEqual(40);
  expect(Math.abs(bounds.y - target.y)).toBeLessThanOrEqual(40);
});

test('proxy-setting menu checkboxes write settings and stay in sync', async () => {
  launched = await launchApp();
  const { app, page } = launched;
  const settings = () => page.evaluate(() => window.reversee.getSettings());

  expect(await menuChecked(app, 'host')).toBe(true);
  await clickMenu(app, ['Proxy Settings', 'Rewrite host']);
  await expect.poll(async () => (await settings()).rewriteHost).toBe(false);
  expect(await menuChecked(app, 'host')).toBe(false);

  // A change from elsewhere (the renderer / MCP) is reflected in the menu.
  await page.evaluate(() => window.reversee.setSettings({ mcpAllowControl: true }));
  await expect.poll(() => menuChecked(app, 'mcp-control')).toBe(true);
});

test('menu Reset Cache restores default settings and clears traffic', async () => {
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
  const { app, page } = launched;
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(/Proxy running/)).toBeVisible();
  await fetchViaProxy(listenPort, '/before-reset');
  await expect(page.getByRole('row').filter({ hasText: '/before-reset' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Proxy stopped')).toBeVisible();

  await clickMenu(app, ['Proxy Settings', 'Reset Cache']);

  await expect(page.getByLabel('Destination host')).toHaveValue('');
  await expect(page.getByRole('row').filter({ hasText: '/before-reset' })).toHaveCount(0);
  await expect(page.getByText(/No traffic yet/)).toBeVisible();
});

test('menu items open the matching dialogs', async () => {
  launched = await launchApp();
  const { app, page } = launched;
  // The renderer subscribes to menu events during its async init; retry the
  // first click until it is listening.
  const openVia = async (labels: string[], dialog: string | RegExp) => {
    await expect(async () => {
      await clickMenu(app, labels);
      await expect(page.getByRole('dialog', { name: dialog })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  await openVia(['Breakpoints', 'Edit'], 'Breakpoints');
  await openVia(['gRPC', 'Proto Specs…'], 'Proto Specs');
  await openVia(['Help', 'Connect an AI Agent (MCP)…'], /Connect an AI agent/);
});

test('a second instance on the same profile exits and leaves the first running', async () => {
  launched = await launchApp();
  const second = spawn(
    electronPath as unknown as string,
    [path.join(repoRoot, 'out', 'main', 'index.js')],
    {
      env: { ...process.env, REVERSEE_USER_DATA: launched.userDataDir, NODE_ENV: 'production' },
      stdio: 'ignore',
    }
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill();
      reject(new Error('second instance did not exit'));
    }, 20_000);
    second.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  expect(code).toBe(0);
  // The first instance is untouched.
  await expect(launched.page.getByText('Proxy stopped')).toBeVisible();
  expect(launched.app.windows()).toHaveLength(1);
});
