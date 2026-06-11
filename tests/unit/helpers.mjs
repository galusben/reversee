// Test harness that drives the proxy core (src/proxy/core) headlessly using
// the real createProxyServer, against real http/https fixture upstreams.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from '../../src/proxy/core/server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'resources', 'localhost.key')),
  cert: fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'resources', 'localhost.cert')),
};

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

export async function startUpstream(handler, { tls = false } = {}) {
  const server = tls ? https.createServer(sslOptions, handler) : http.createServer(handler);
  const port = await listen(server);
  return { server, port };
}

export async function startProxyServer(settings, { gate } = {}) {
  const traffic = [];
  const waiters = [];
  const notify = (trafficView) => {
    traffic.push(trafficView);
    while (waiters.length) waiters.shift()(trafficView);
  };

  settings.listenPort = settings.listenPort ?? 0;
  const server = createProxyServer({
    settings,
    notify,
    sslOptions: settings.listenProtocol === 'https' ? sslOptions : undefined,
    gate,
  });
  const port = await server.listen();

  return {
    server,
    port,
    traffic,
    nextTraffic: () => new Promise((resolve) => waiters.push(resolve)),
  };
}

export function request({ tls = false, port, path: reqPath = '/', method = 'GET', headers = {}, body = null }) {
  const mod = tls ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      { hostname: '127.0.0.1', port, path: reqPath, method, headers, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export function closeAll(...servers) {
  return Promise.all(
    servers
      .filter(Boolean)
      .map((s) => {
        if (typeof s.listen === 'function' && typeof s.close === 'function' && !(s instanceof http.Server)) {
          return s.close(); // ProxyServer handle
        }
        return new Promise((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        });
      })
  );
}

// Standard settings: proxy 127.0.0.1:<listen> -> 127.0.0.1:<upstream>
export function makeSettings(upstreamPort, overrides = {}) {
  return {
    dest: '127.0.0.1',
    destProtocol: 'http',
    destPort: upstreamPort,
    listenPort: 0,
    listenProtocol: 'http',
    redirect: false,
    hostRewrite: false,
    ...overrides,
  };
}
