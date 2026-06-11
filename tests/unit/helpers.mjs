// Test harness that drives src/proxy.js headlessly, replicating the listening
// server wrapper from src/proxyWin.js (collect request body, then call
// proxy.handleRequest(req, res, settings, notify, {body})).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// request-to-curl monkey-patches http internals via process.binding at require
// time, which aborts the process on modern Node. Seed the require cache with a
// stub before proxy.js loads it; its curl output is not under test here and
// the dependency is removed entirely in milestone A5.
const requestToCurlPath = require.resolve('request-to-curl', {
  paths: [path.join(__dirname, '..', '..')],
});
require.cache[requestToCurlPath] = {
  id: requestToCurlPath,
  filename: requestToCurlPath,
  loaded: true,
  exports: {},
};
http.ClientRequest.prototype.toCurl = function () {
  return `curl-stub ${this.method} ${this.path}`;
};

const proxy = require(path.join(__dirname, '..', '..', 'src', 'proxy.js'));

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

// Mirrors handleRequestWrapper in src/proxyWin.js (without breakpoints).
export async function startProxyServer(settings) {
  const traffic = [];
  const waiters = [];
  const notify = (trafficView) => {
    traffic.push(trafficView);
    while (waiters.length) waiters.shift()(trafficView);
  };

  const handler = (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      proxy.handleRequest(request, response, settings, notify, { body });
    });
  };

  const server =
    settings.listenProtocol === 'https'
      ? https.createServer(settings.sslOptions || sslOptions, handler)
      : http.createServer(handler);
  const port = await listen(server);
  settings.listenPort = settings.listenPort || port;

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
      .map((s) => new Promise((resolve) => {
        s.closeAllConnections?.();
        s.close(() => resolve());
      }))
  );
}

// Standard settings: proxy 127.0.0.1:<listen> -> 127.0.0.1:<upstream>
export function makeSettings(upstreamPort, overrides = {}) {
  return {
    dest: '127.0.0.1',
    destProtocol: 'http',
    destPort: upstreamPort,
    listenProtocol: 'http',
    redirect: false,
    hostRewrite: false,
    ...overrides,
  };
}
