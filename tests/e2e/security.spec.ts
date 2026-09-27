// Renderer hardening, checked against the real built app: webPreferences, the
// preload surface, the CSP, and the navigation / window.open lockdown. These
// are the guarantees most likely to shift under an Electron major.
import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './fixtures/launch';

let launched: LaunchedApp | null = null;

test.afterEach(async () => {
  await launched?.close().catch(() => {});
  launched = null;
});

const EXPECTED_API = [
  'clearTraffic',
  'copyToClipboard',
  'getBreakpoints',
  'getProtoSpecs',
  'getSettings',
  'getTraffic',
  'getVersion',
  'importProtoSpec',
  'migrateLegacySettings',
  'onBreakpointErrors',
  'onBreakpointHit',
  'onOpenBreakpoints',
  'onOpenConnectAi',
  'onOpenProtoSpecs',
  'onProxyError',
  'onProxyState',
  'onSettingsChanged',
  'onTraffic',
  'onTrafficCleared',
  'removeProtoSpec',
  'resumeBreakpoint',
  'setBreakpoints',
  'setSettings',
  'startProxy',
  'stopProxy',
];

test('main window runs sandboxed with context isolation and no node integration', async () => {
  launched = await launchApp();
  const prefs = await launched.app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      contextIsolation: p?.contextIsolation,
      sandbox: p?.sandbox,
      nodeIntegration: p?.nodeIntegration,
      nodeIntegrationInSubFrames: p?.nodeIntegrationInSubFrames,
      webSecurity: p?.webSecurity,
    };
  });
  expect(prefs).toEqual({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
  });
});

test('renderer sees only the typed preload API', async () => {
  launched = await launchApp();
  const { page } = launched;
  const surface = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const api = w['reversee'] as Record<string, unknown>;
    return {
      keys: Object.keys(api).sort(),
      allFunctions: Object.values(api).every((v) => typeof v === 'function'),
      frozen: Object.isFrozen(api),
      leaks: ['require', 'process', 'module', 'Buffer', 'ipcRenderer', 'electron'].filter(
        (k) => typeof w[k] !== 'undefined'
      ),
    };
  });
  expect(surface.keys).toEqual(EXPECTED_API);
  expect(surface.allFunctions).toBe(true);
  // contextBridge hands the page a frozen clone.
  expect(surface.frozen).toBe(true);
  expect(surface.leaks).toEqual([]);
  expect(await page.evaluate(() => window.reversee.getVersion())).toMatch(/^\d+\.\d+\.\d+/);
});

test('the content security policy blocks inline script', async () => {
  launched = await launchApp();
  const { page } = launched;

  // The policy itself: no inline or eval escape hatches for script.
  const policy = await page.evaluate(
    () =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? ''
  );
  const scriptSrc = policy.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
  expect(scriptSrc.trim()).toBe("script-src 'self'");
  expect(policy).toContain("default-src 'self'");

  // And it is enforced. (eval can't be probed here: DevTools-evaluated code,
  // which page.evaluate uses, is exempt from the page CSP.)
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      violations.push(e.effectiveDirective)
    );
    const script = document.createElement('script');
    script.textContent = 'window.__inlineRan = true';
    document.body.appendChild(script);
    await new Promise((r) => setTimeout(r, 50));
    return {
      inlineRan: (window as unknown as Record<string, unknown>)['__inlineRan'] === true,
      violations,
    };
  });
  expect(result.inlineRan).toBe(false);
  expect(result.violations).toContain('script-src-elem');
  // The fixture captured the violation as a console error — proof the
  // renderer-error guard the other specs rely on actually works.
  expect(launched.rendererErrors.join('\n')).toMatch(/Content Security Policy/);
});

async function recordExternalOpens(app: LaunchedApp['app']): Promise<() => Promise<unknown>> {
  // Record instead of really opening a browser.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as Record<string, unknown>)['__opened'] = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return () => app.evaluate(() => (globalThis as Record<string, unknown>)['__opened']);
}

test('window.open is denied; only allowlisted links open externally', async () => {
  launched = await launchApp();
  const { app, page } = launched;
  const opened = await recordExternalOpens(app);

  expect(await page.evaluate(() => window.open('https://evil.example/') === null)).toBe(true);
  expect(app.windows()).toHaveLength(1);

  // The Connect AI "Learn more" link is on the allowlist.
  await page.getByRole('button', { name: /Connect AI/ }).click();
  await page.getByRole('link', { name: /Learn more/ }).click();
  await expect
    .poll(opened)
    .toEqual([expect.stringMatching(/^https:\/\/github\.com\/galusben\/reversee/)]);
  expect(app.windows()).toHaveLength(1);
});

test('the renderer cannot navigate away', async () => {
  launched = await launchApp();
  const { app, page } = launched;
  const urlInMain = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
  const startUrl = await urlInMain();
  expect(startUrl).toMatch(/^file:/);

  // Fire and forget: the cancelled navigation never "finishes" for Playwright,
  // so check the outcome from main rather than through the page.
  void page
    .evaluate(() => {
      location.href = 'https://evil.example/';
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  expect(await urlInMain()).toBe(startUrl);
  expect(app.windows()).toHaveLength(1);
});
