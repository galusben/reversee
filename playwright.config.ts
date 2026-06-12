import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  // Each test launches its own Electron instance; keep them serial.
  workers: 1,
  retries: 2,
  timeout: 60_000,
  use: {
    trace: 'retain-on-failure',
  },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
});
