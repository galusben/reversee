// End-to-end gRPC flow through the real built app: enable gRPC, proxy a live
// gRPC call (unary + server-streaming), and assert the decoded messages and
// status show in the UI. With CAPTURE_SCREENSHOTS=1 it also writes the docs
// screenshots.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, freePort, type LaunchedApp } from './fixtures/launch';
import { startGrpcUpstream, grpcCall, seedProtoSpec, type GrpcUpstream } from './fixtures/grpc';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shotsDir = path.join(repoRoot, 'docs', 'screenshots');
const capture = !!process.env['CAPTURE_SCREENSHOTS'];

let launched: LaunchedApp | null = null;
let upstream: GrpcUpstream | null = null;

test.afterEach(async () => {
  await launched?.close().catch(() => {});
  await upstream?.close().catch(() => {});
  launched = null;
  upstream = null;
});

test('proxies and decodes native gRPC — unary and server streaming', async () => {
  upstream = await startGrpcUpstream();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-grpc-e2e-'));
  seedProtoSpec(userDataDir); // the Greeter .proto, as if previously imported
  const listenPort = await freePort();

  launched = await launchApp({
    userDataDir,
    settings: {
      dest: '127.0.0.1',
      destProtocol: 'http',
      destPort: upstream.port,
      listenProtocol: 'http',
      listenPort,
      enableGrpc: true,
    },
  });
  const { page } = launched;

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText(`Proxy running on port ${listenPort}`)).toBeVisible();

  // Unary call.
  const unary = await grpcCall(listenPort, '/greet.Greeter/SayHello', 'Ada');
  expect(unary.status).toBe(0);
  expect(unary.messages).toEqual(['Hello, Ada']);

  // Server-streaming call (M3): one request, three replies.
  const streamed = await grpcCall(listenPort, '/greet.Greeter/SayManyHellos', 'Bob');
  expect(streamed.messages).toEqual(['Hello Bob #1', 'Hello Bob #2', 'Hello Bob #3']);

  // The unary row is flagged gRPC and decodes both ways.
  const unaryRow = page.getByRole('row').filter({ hasText: '/greet.Greeter/SayHello' }).first();
  await expect(unaryRow).toBeVisible();
  await expect(unaryRow).toContainText('gRPC');
  await unaryRow.click();
  await expect(page.getByText(/"name":\s*"Ada"/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/"message":\s*"Hello, Ada"/)).toBeVisible();
  await expect(page.getByText(/status 0 OK/)).toBeVisible();

  // The streaming row decodes every message.
  const streamRow = page
    .getByRole('row')
    .filter({ hasText: '/greet.Greeter/SayManyHellos' })
    .first();
  await streamRow.click();
  await expect(page.getByText(/Response \(3\)/)).toBeVisible();
  await expect(page.getByText(/"message":\s*"Hello Bob #3"/)).toBeVisible();

  if (capture) {
    fs.mkdirSync(shotsDir, { recursive: true });
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 820);
    });
    // Decoded streaming call in the detail pane.
    await expect(page.getByText(/"message":\s*"Hello Bob #3"/)).toBeVisible();
    await page.screenshot({ path: path.join(shotsDir, 'grpc-decoded.png') });

    // The Proto Specs manager (opened the same way the gRPC menu does).
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ui:open-proto-specs');
    });
    await expect(page.getByText('Proto Specs')).toBeVisible();
    await expect(page.getByText('greeter.proto')).toBeVisible();
    await page.screenshot({ path: path.join(shotsDir, 'grpc-specs.png') });
    await page.keyboard.press('Escape'); // close the dialog so Stop is clickable
    await expect(page.getByText('Proto Specs')).toBeHidden();
  }

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('Proxy stopped')).toBeVisible();
});
