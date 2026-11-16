// "Capture anything" mode (src/proxy/core/forward.ts): the listener used as a
// regular HTTP proxy. Plain HTTP arrives in absolute form; HTTPS arrives as a
// CONNECT tunnel whose TLS is terminated with a certificate issued per host by
// the real root-CA code, and verified by a client that trusts only that root.
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { startUpstream, startProxyServer, closeAll, makeSettings, request } from './helpers.mjs';
import { startWsEchoServer } from '../fixtures/ws-echo';
import { parseAuthority, takeAbsoluteTarget } from '../../src/proxy/core/forward';

vi.mock('electron', () => ({ dialog: {} }));
vi.mock('electron-log', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('../../src/main/settings', () => ({ readRootCert: () => ({ state: 'missing' }) }));
const { createRootCert, createHostCertIssuer } = await import('../../src/main/certs/certs');

let root;
let issue;
const issued = [];
beforeAll(() => {
  root = createRootCert();
  const issuer = createHostCertIssuer(root);
  issue = async (host) => {
    issued.push(host);
    const leaf = issuer(host);
    return { key: leaf.privateKey, cert: leaf.certificate };
  };
}, 60_000);

let cleanup = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
  issued.length = 0;
});

const captureSettings = (overrides = {}) =>
  makeSettings(1, { dest: '', captureAll: true, ...overrides });

async function startCapture(overrides, options = {}) {
  const proxy = await startProxyServer(captureSettings(overrides), {
    issueCert: issue,
    ...options,
  });
  cleanup.push(() => closeAll(proxy.server));
  return proxy;
}

async function upstream(handler, options) {
  const up = await startUpstream(handler, options);
  cleanup.push(() => closeAll(up.server));
  return up;
}

/** Sends a raw request line + headers to the proxy and returns the whole answer. */
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('error', reject);
    socket.write(text);
  });
}

/** Opens a CONNECT tunnel; resolves with the status code and the tunnel socket. */
function connect(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
    });
    req.on('connect', (res, socket) => resolve({ statusCode: res.statusCode, socket, res }));
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode, res, body: Buffer.concat(chunks).toString() })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** One request over an existing (tunnel) stream. */
function requestOver(stream, { path = '/', method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent();
    agent.createConnection = () => stream;
    const req = http.request({ agent, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** CONNECT, then a TLS handshake that trusts ONLY the Reversee root. */
async function secureTunnel(proxyPort, host, port, tlsOptions = {}) {
  const { statusCode, socket } = await connect(proxyPort, `${host}:${port}`);
  expect(statusCode).toBe(200);
  socket.on('error', () => {}); // torn down by the proxy in the stop test
  const secure = tls.connect({
    socket,
    ca: root.certificate,
    host,
    ...(net.isIP(host) ? {} : { servername: host }),
    ...tlsOptions,
  });
  cleanup.push(() => secure.destroy());
  await once(secure, 'secureConnect');
  return secure;
}

describe('parsing', () => {
  it('splits CONNECT authorities', () => {
    expect(parseAuthority('example.com:443', 443)).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('example.com', 80)).toEqual({ host: 'example.com', port: 80 });
    expect(parseAuthority('[::1]:8443', 443)).toEqual({ host: '::1', port: 8443 });
    expect(parseAuthority('', 443)).toBeNull();
    expect(parseAuthority('a b:1', 443)).toBeNull();
    expect(parseAuthority('example.com:0', 443)).toBeNull();
    expect(parseAuthority('example.com:99999', 443)).toBeNull();
  });

  it('turns an absolute-form request into origin form', () => {
    const req = { url: 'http://user:pw@Example.com:8080/a/b?x=1' };
    expect(takeAbsoluteTarget(req)).toEqual({ protocol: 'http', host: 'Example.com', port: 8080 });
    expect(req.url).toBe('/a/b?x=1');

    const bare = { url: 'https://example.com?q=1' };
    expect(takeAbsoluteTarget(bare)).toEqual({ protocol: 'https', host: 'example.com', port: 443 });
    expect(bare.url).toBe('/?q=1');

    const origin = { url: '/just/a/path' };
    expect(takeAbsoluteTarget(origin)).toBeNull();
    expect(origin.url).toBe('/just/a/path');
  });
});

describe('plain HTTP through the proxy', () => {
  it('forwards an absolute-form request to the server it names', async () => {
    let seen;
    const up = await upstream((req, res) => {
      seen = { url: req.url, headers: req.headers };
      res.end('hello');
    });
    // Host rewriting and redirect rewriting belong to the one-server mode.
    const proxy = await startCapture({ hostRewrite: true, redirect: true });

    const res = await request({
      port: proxy.port,
      path: `http://127.0.0.1:${up.port}/things?id=7`,
      headers: { host: `127.0.0.1:${up.port}`, 'proxy-connection': 'keep-alive' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('hello');
    expect(seen.url).toBe('/things?id=7');
    expect(seen.headers.host).toBe(`127.0.0.1:${up.port}`);
    expect(seen.headers['proxy-connection']).toBeUndefined();

    expect(proxy.traffic).toHaveLength(1);
    const entry = proxy.traffic[0];
    expect(entry.request.url).toBe('/things?id=7');
    expect(entry.request.target).toEqual({ protocol: 'http', host: '127.0.0.1', port: up.port });
  });

  it('leaves the redirects of the real server alone', async () => {
    const up = await upstream((req, res) => {
      res.writeHead(302, { location: 'http://elsewhere.test/next' }).end();
    });
    const proxy = await startCapture({ redirect: true });
    const res = await request({ port: proxy.port, path: `http://127.0.0.1:${up.port}/` });
    expect(res.headers.location).toBe('http://elsewhere.test/next');
  });

  it('explains itself to a client that treats it as a web server', async () => {
    const proxy = await startCapture();
    const res = await request({ port: proxy.port, path: '/' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-reversee-error']).toBe('not-a-proxy-request');
    expect(res.body.toString()).toContain(`http://127.0.0.1:${proxy.port}`);
    expect(proxy.traffic).toHaveLength(0);
  });

  it('refuses a request that points back at itself', async () => {
    const proxy = await startCapture();
    const res = await request({ port: proxy.port, path: `http://localhost:${proxy.port}/` });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-reversee-error']).toBe('proxy-loop');
  });

  it('still applies route rules and mocks', async () => {
    const real = await upstream((req, res) => res.end('real'));
    const other = await upstream((req, res) => res.end('routed'));
    const proxy = await startCapture({
      routes: [
        {
          id: 'r1',
          enabled: true,
          pathPattern: '^/routed',
          destProtocol: 'http',
          dest: '127.0.0.1',
          destPort: other.port,
        },
      ],
      mocks: [
        {
          id: 'm1',
          enabled: true,
          pathPattern: '^/mocked',
          statusCode: 418,
          headers: {},
          body: 'tea',
        },
      ],
    });
    const base = `http://127.0.0.1:${real.port}`;
    expect((await request({ port: proxy.port, path: `${base}/plain` })).body.toString()).toBe(
      'real'
    );
    expect((await request({ port: proxy.port, path: `${base}/routed` })).body.toString()).toBe(
      'routed'
    );
    const mocked = await request({ port: proxy.port, path: `${base}/mocked` });
    expect(mocked.statusCode).toBe(418);
    expect(mocked.body.toString()).toBe('tea');
  });

  it('runs request scripts and breakpoints on forwarded requests', async () => {
    let seen;
    const up = await upstream((req, res) => {
      seen = req.headers;
      res.end('ok');
    });
    const gated = [];
    const proxy = await startCapture(
      { interceptRequest: true, requestInterceptor: "requestParams.headers['x-added'] = 'yes'" },
      {
        gate: (req) => {
          gated.push(req.url);
          return null;
        },
      }
    );
    await request({ port: proxy.port, path: `http://127.0.0.1:${up.port}/scripted` });
    expect(seen['x-added']).toBe('yes');
    expect(gated).toEqual(['/scripted']);
  });
});

describe('HTTPS through a CONNECT tunnel', () => {
  it('decrypts with a certificate the client accepts for that host', async () => {
    let seen;
    const up = await upstream(
      (req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          seen = { url: req.url, method: req.method, body: Buffer.concat(chunks).toString() };
          res.setHeader('content-type', 'application/json');
          res.end('{"secret":true}');
        });
      },
      { tls: true }
    );
    const proxy = await startCapture();

    const secure = await secureTunnel(proxy.port, 'localhost', up.port);
    expect(secure.authorized).toBe(true);
    expect(secure.getPeerCertificate().subject.CN).toBe('localhost');
    expect(secure.alpnProtocol === false || secure.alpnProtocol === 'http/1.1').toBe(true);

    const res = await requestOver(secure, {
      path: '/login',
      method: 'POST',
      headers: { host: `localhost:${up.port}`, 'content-length': '4' },
      body: 'pass',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('{"secret":true}');
    expect(seen).toEqual({ url: '/login', method: 'POST', body: 'pass' });

    expect(proxy.traffic).toHaveLength(1);
    const entry = proxy.traffic[0];
    expect(entry.request.url).toBe('/login');
    expect(Buffer.from(entry.request.body).toString()).toBe('pass');
    expect(entry.request.target).toEqual({ protocol: 'https', host: 'localhost', port: up.port });
    expect(Buffer.from(entry.response.body).toString()).toBe('{"secret":true}');
  });

  it('serves several requests on one tunnel and issues one certificate per host', async () => {
    const up = await upstream((req, res) => res.end(req.url), { tls: true });
    const proxy = await startCapture();

    const secure = await secureTunnel(proxy.port, 'localhost', up.port);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    agent.createConnection = () => secure;
    cleanup.push(() => agent.destroy());
    const get = (path) =>
      new Promise((resolve, reject) => {
        http
          .get({ agent, path, headers: { host: 'localhost' } }, (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve(text));
          })
          .on('error', reject);
      });
    expect(await get('/one')).toBe('/one');
    expect(await get('/two')).toBe('/two');

    await secureTunnel(proxy.port, 'localhost', up.port);
    expect(issued).toEqual(['localhost']);
    expect(proxy.traffic.map((t) => t.request.url)).toEqual(['/one', '/two']);
  });

  it('issues an address certificate when the client connects by IP', async () => {
    const up = await upstream((req, res) => res.end('by ip'), { tls: true });
    const proxy = await startCapture();
    const secure = await secureTunnel(proxy.port, '127.0.0.1', up.port);
    expect(secure.authorized).toBe(true);
    const res = await requestOver(secure, { headers: { host: '127.0.0.1' } });
    expect(res.body.toString()).toBe('by ip');
  });

  it('follows the SNI name when it differs from the CONNECT target', async () => {
    const up = await upstream((req, res) => res.end('sni'), { tls: true });
    const proxy = await startCapture();
    const secure = await secureTunnel(proxy.port, '127.0.0.1', up.port, {
      servername: 'api.example.test',
    });
    expect(secure.authorized).toBe(true);
    expect(issued).toContain('api.example.test');
  });

  it('reports a client that does not trust the certificate', async () => {
    const up = await upstream((req, res) => res.end('never'), { tls: true });
    const proxy = await startCapture();

    const { socket } = await connect(proxy.port, `localhost:${up.port}`);
    // No `ca`: the Reversee root is unknown to this client.
    const secure = tls.connect({ socket, servername: 'localhost' });
    const [err] = await once(secure, 'error');
    expect(err.code).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/);

    for (let i = 0; i < 200 && proxy.traffic.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(proxy.traffic).toHaveLength(1);
    const entry = proxy.traffic[0];
    expect(entry.request.method).toBe('CONNECT');
    expect(entry.request.url).toBe(`localhost:${up.port}`);
    expect(entry.connectorError.code).toBe('CLIENT_TLS_REJECTED');
    expect(entry.connectorError.message).toContain('root certificate');
  });

  it('passes the tunnel through untouched when it cannot issue certificates', async () => {
    const up = await upstream((req, res) => res.end('end to end'), { tls: true });
    const proxy = await startProxyServer(captureSettings());
    cleanup.push(() => closeAll(proxy.server));

    const { socket } = await connect(proxy.port, `127.0.0.1:${up.port}`);
    const secure = tls.connect({ socket, rejectUnauthorized: false });
    cleanup.push(() => secure.destroy());
    await once(secure, 'secureConnect');
    // The upstream's own (self-signed fixture) certificate, not one of ours.
    expect(secure.getPeerCertificate().issuer.CN).not.toBe('reversee.ninja');
    const res = await requestOver(secure, { headers: { host: 'localhost' } });
    expect(res.body.toString()).toBe('end to end');
    expect(proxy.traffic).toHaveLength(0);
  });
});

describe('other traffic in a CONNECT tunnel', () => {
  it('captures plain HTTP sent through a tunnel', async () => {
    const up = await upstream((req, res) => res.end('plain in tunnel'));
    const proxy = await startCapture();
    const { socket } = await connect(proxy.port, `127.0.0.1:${up.port}`);
    cleanup.push(() => socket.destroy());
    const res = await requestOver(socket, { path: '/t', headers: { host: '127.0.0.1' } });
    expect(res.body.toString()).toBe('plain in tunnel');
    expect(proxy.traffic[0].request.target).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: up.port,
    });
  });

  it('tunnels a WebSocket and records its messages', async () => {
    const echo = await startWsEchoServer();
    cleanup.push(() => echo.close());
    const proxy = await startCapture();
    const { socket } = await connect(proxy.port, `127.0.0.1:${echo.port}`);
    cleanup.push(() => socket.destroy());

    const upgraded = await new Promise((resolve, reject) => {
      const agent = new http.Agent();
      agent.createConnection = () => socket;
      const req = http.request({
        agent,
        path: '/chat',
        headers: {
          host: `127.0.0.1:${echo.port}`,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      req.on('upgrade', (res) => resolve(res));
      req.on('response', (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
      req.on('error', reject);
      req.end();
    });
    expect(upgraded.statusCode).toBe(101);
    for (let i = 0; i < 200 && proxy.traffic.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(proxy.traffic[0].ws).toBeDefined();
    expect(proxy.traffic[0].request.url).toBe('/chat');
  });

  it('pipes a protocol it does not understand straight through', async () => {
    const server = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => server.close(r)));
    const proxy = await startCapture();

    const { socket } = await connect(proxy.port, `127.0.0.1:${server.address().port}`);
    cleanup.push(() => socket.destroy());
    socket.write('ping');
    const [data] = await once(socket, 'data');
    expect(data.toString()).toBe('echo:ping');
    expect(proxy.traffic).toHaveLength(0);
  });

  it('rejects a malformed CONNECT target', async () => {
    const proxy = await startCapture();
    const answer = await raw(proxy.port, 'CONNECT not a host HTTP/1.1\r\n\r\n');
    expect(answer).toMatch(/^HTTP\/1\.1 400/);
  });
});

describe('with capture anything off', () => {
  it('tells a proxy client to switch modes', async () => {
    const up = await upstream((req, res) => res.end('one server'));
    const proxy = await startProxyServer(makeSettings(up.port));
    cleanup.push(() => closeAll(proxy.server));

    const answer = await connect(proxy.port, 'example.com:443');
    expect(answer.statusCode).toBe(405);
    expect(answer.res.headers['x-reversee-error']).toBe('capture-anything-off');
    // The one-server mode is unaffected.
    expect((await request({ port: proxy.port, path: '/' })).body.toString()).toBe('one server');
  });
});

describe('stopping', () => {
  it('closes open tunnels', async () => {
    const up = await upstream((req, res) => res.end('x'), { tls: true });
    const proxy = await startProxyServer(captureSettings(), { issueCert: issue });
    const secure = await secureTunnel(proxy.port, 'localhost', up.port);
    secure.on('error', () => {}); // a reset is as good as a clean close here
    const closed = new Promise((resolve) => secure.on('close', resolve));
    await closeAll(proxy.server);
    await closed;
  });
});

describe('exposure', () => {
  it('listens on this machine only', async () => {
    const proxy = await startCapture();
    const res = await raw(proxy.port, 'GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n');
    expect(res).toMatch(/^HTTP\/1\.1 400/);
    // Not bound on the IPv6 wildcard / other interfaces.
    await expect(
      new Promise((resolve, reject) => {
        const s = net.connect(proxy.port, '::1');
        s.on('connect', () => (s.destroy(), resolve('connected')));
        s.on('error', reject);
      })
    ).rejects.toThrow();
  });
});
