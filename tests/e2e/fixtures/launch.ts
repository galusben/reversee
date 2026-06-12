// Shared e2e harness: launches the built app against an isolated temp
// profile, optionally pre-seeding settings, plus a local fixture upstream.
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..', '..');

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  close(): Promise<void>;
}

export async function launchApp(options?: {
  userDataDir?: string;
  settings?: Record<string, unknown>;
}): Promise<LaunchedApp> {
  const userDataDir =
    options?.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-e2e-'));

  if (options?.settings) {
    // Same file electron-store reads (store name 'config').
    const configPath = path.join(userDataDir, 'config.json');
    const existing = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
      : {};
    existing.appSettings = { ...existing.appSettings, ...options.settings };
    fs.writeFileSync(configPath, JSON.stringify(existing));
  }

  const app = await electron.launch({
    args: [path.join(repoRoot, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      REVERSEE_USER_DATA: userDataDir,
      NODE_ENV: 'production',
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  return {
    app,
    page,
    userDataDir,
    close: async () => {
      await app.close();
    },
  };
}

export interface Upstream {
  port: number;
  requests: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders; body: string }>;
  close(): Promise<void>;
}

export function startUpstream(
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  { tls = false } = {}
): Promise<Upstream> {
  const requests: Upstream['requests'] = [];
  const wrapped = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (handler) handler(req, res);
      else res.end('upstream response');
    });
  };
  const server = tls
    ? https.createServer(
        {
          key: fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'localhost.key')),
          cert: fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'localhost.cert')),
        },
        wrapped
      )
    : http.createServer(wrapped);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        requests,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Binds a port on all interfaces so the app's own listen collides. */
export function occupyPort(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export function fetchViaProxy(
  port: number,
  reqPath = '/',
  { tls = false, method = 'GET', headers = {}, body = null as string | null } = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  const mod = tls ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      { hostname: '127.0.0.1', port, path: reqPath, method, headers, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
