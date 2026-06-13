import { defineConfig } from '@playwright/test';

// Separate config: the smoke suite drives the FINAL packaged app (via
// REVERSEE_APP_BIN), not the dev build that playwright.config.ts uses.
export default defineConfig({
  testDir: 'tests/smoke',
  workers: 1,
  retries: 1,
  timeout: 90_000,
  reporter: 'list',
});
