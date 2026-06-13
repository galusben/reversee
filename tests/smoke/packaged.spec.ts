// Smoke test for the FINAL packaged, signed app (not the dev build). The
// release pipeline downloads the published artifact, installs it, and points
// REVERSEE_APP_BIN at the app executable inside the bundle.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_BIN = process.env.REVERSEE_APP_BIN;
const EXPECTED_VERSION = process.env.REVERSEE_EXPECTED_VERSION;

test('packaged app launches, exposes the API, reports the expected version', async () => {
  expect(APP_BIN, 'REVERSEE_APP_BIN must point at the packaged app executable').toBeTruthy();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-smoke-'));

  const app = await electron.launch({
    executablePath: APP_BIN!,
    args: [],
    env: { ...process.env, REVERSEE_USER_DATA: userDataDir, NODE_ENV: 'production' },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Window is real and the secure preload bridge is present.
    await expect(page.getByText(/Proxy stopped/)).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => typeof (window as never)['require'])).toBe('undefined');
    expect(await page.evaluate(() => typeof (window as { reversee?: unknown }).reversee)).toBe(
      'object'
    );

    const version = await page.evaluate(() => (window as { reversee: { getVersion(): Promise<string> } }).reversee.getVersion());
    if (EXPECTED_VERSION) {
      expect(version).toBe(EXPECTED_VERSION);
    } else {
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    }
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
