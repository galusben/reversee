// Rules swapped on a running listener, and the readable answer a plain-HTTP
// client gets from an HTTPS listener.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import zlib from 'node:zlib';
import {
  startUpstream,
  startProxyServer,
  request,
  closeAll,
  makeSettings,
  sslOptions,
} from './helpers.mjs';
import { createHttp2ProxyServer } from '../../src/proxy/core/http2';
import { plainHttpHint } from '../../src/proxy/core/tls-hint';

let open = [];
afterEach(async () => {
  await closeAll(...open);
  open = [];
});

const mock = (overrides) => ({
  id: 'm1',
  enabled: true,
  pathPattern: '^/flags',
  statusCode: 200,
  headers: { 'content-type': 'text/plain' },
  body: 'mocked',
  ...overrides,
});

/** Sends raw bytes and resolves with everything the server sent back. */
function rawExchange(port, bytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes));
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
  });
}

describe('live rule updates', () => {
  it('applies new mocks and routes without restarting the listener', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'));
    const other = await startUpstream((_req, res) => res.end('other'));
    const proxy = await startProxyServer(makeSettings(upstream.port));
    open.push(upstream.server, other.server, proxy.server);
    const get = (path) => request({ port: proxy.port, path });

    expect((await get('/flags')).body.toString()).toBe('upstream');

    proxy.server.setRules({
      mocks: [mock()],
      routes: [
        {
          id: 'r1',
          enabled: true,
          pathPattern: '^/v2',
          destProtocol: 'http',
          dest: '127.0.0.1',
          destPort: other.port,
        },
      ],
    });
    expect((await get('/flags')).body.toString()).toBe('mocked');
    expect((await get('/v2/x')).body.toString()).toBe('other');
    expect((await get('/v1/x')).body.toString()).toBe('upstream');
    expect(proxy.server.listening).toBe(true);

    // Edited, then removed.
    proxy.server.setRules({ mocks: [mock({ body: 'changed', statusCode: 418 })] });
    const changed = await get('/flags');
    expect(changed.statusCode).toBe(418);
    expect(changed.body.toString()).toBe('changed');
    expect((await get('/v2/x')).body.toString()).toBe('upstream');

    proxy.server.setRules({});
    expect((await get('/flags')).body.toString()).toBe('upstream');
  });

  it('applies to the gRPC-mode listener too', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'));
    const proxy = createHttp2ProxyServer({
      settings: { ...makeSettings(upstream.port), listenPort: 0, enableGrpc: true },
      notify: () => {},
    });
    const port = await proxy.listen();
    open.push(upstream.server, proxy);
    expect((await request({ port, path: '/flags' })).body.toString()).toBe('upstream');
    proxy.setRules({ mocks: [mock()] });
    expect((await request({ port, path: '/flags' })).body.toString()).toBe('mocked');
  });
});

describe('plain HTTP sent to an HTTPS listener', () => {
  const plainGet = 'GET /todos/1 HTTP/1.1\r\nHost: localhost\r\n\r\n';

  it('gets a readable 400 instead of a dropped connection', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'));
    const proxy = await startProxyServer(makeSettings(upstream.port, { listenProtocol: 'https' }));
    open.push(upstream.server, proxy.server);

    const reply = await rawExchange(proxy.port, plainGet);
    expect(reply).toBe(plainHttpHint());
    expect(reply).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(reply).toContain('x-reversee-error: plain-http-on-https-listener');
    expect(reply).toContain('expects HTTPS');
    expect(proxy.traffic).toHaveLength(0);

    // Real HTTPS clients are unaffected.
    const ok = await request({ port: proxy.port, path: '/x', tls: true });
    expect(ok.body.toString()).toBe('upstream');
  });

  it('also on the gRPC-mode HTTPS listener', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'));
    const proxy = createHttp2ProxyServer({
      settings: {
        ...makeSettings(upstream.port, { listenProtocol: 'https' }),
        listenPort: 0,
        enableGrpc: true,
      },
      sslOptions,
      notify: () => {},
    });
    const port = await proxy.listen();
    open.push(upstream.server, proxy);
    expect(await rawExchange(port, plainGet)).toBe(plainHttpHint());
  });

  it('other TLS failures are left alone', async () => {
    const upstream = await startUpstream((_req, res) => res.end('upstream'));
    const proxy = await startProxyServer(makeSettings(upstream.port, { listenProtocol: 'https' }));
    open.push(upstream.server, proxy.server);
    // Bytes that are neither TLS nor an HTTP request: no hint is written.
    const reply = await rawExchange(proxy.port, 'XYZZY this is not a protocol\r\n\r\n');
    expect(reply).not.toContain('HTTP/1.1');
  });
});

describe('live script updates', () => {
  it('swaps interceptor scripts without restarting the listener', async () => {
    const upstream = await startUpstream((req, res) =>
      res.end(`saw ${req.headers['x-tag'] ?? '-'}`)
    );
    const proxy = await startProxyServer(makeSettings(upstream.port));
    open.push(upstream.server, proxy.server);
    const get = () => request({ port: proxy.port, path: '/' });

    expect((await get()).body.toString()).toBe('saw -');

    proxy.server.setScripts({
      interceptRequest: true,
      requestInterceptor: "requestParams.headers['x-tag'] = 'one'",
      interceptResponse: true,
      responseInterceptor: "responseParams.body = responseParams.body.toString() + '!'",
    });
    expect((await get()).body.toString()).toBe('saw one!');
    // The untouched request is kept, so the script can be tried on it again.
    const last = proxy.traffic.at(-1).request;
    expect(last.headers['x-tag']).toBe('one');
    expect(last.beforeScript).toMatchObject({ url: '/', method: 'GET' });
    expect(last.beforeScript.headers).not.toHaveProperty('x-tag');

    proxy.server.setScripts({
      interceptRequest: true,
      requestInterceptor: "requestParams.headers['x-tag'] = 'two'",
      interceptResponse: false,
      responseInterceptor: '',
    });
    expect((await get()).body.toString()).toBe('saw two');

    proxy.server.setScripts({ interceptRequest: false, interceptResponse: false });
    expect((await get()).body.toString()).toBe('saw -');
    expect(proxy.server.listening).toBe(true);
  });

  it('a response in flight keeps the script it started with', async () => {
    let release;
    const upstream = await startUpstream((_req, res) => {
      release = () => res.end('body');
    });
    const proxy = await startProxyServer(
      makeSettings(upstream.port, {
        interceptResponse: true,
        responseInterceptor: "responseParams.body = 'old script'",
      })
    );
    open.push(upstream.server, proxy.server);

    const pending = request({ port: proxy.port, path: '/' });
    await expect.poll(() => typeof release).toBe('function');
    proxy.server.setScripts({
      interceptResponse: true,
      responseInterceptor: "responseParams.body = 'new script'",
    });
    release();
    expect((await pending).body.toString()).toBe('old script');
  });

  it('gives a response script the decompressed body, and sends the result plain', async () => {
    const upstream = await startUpstream((_req, res) => {
      const body = zlib.gzipSync('{"beta":false}');
      res.writeHead(200, {
        'content-encoding': 'gzip',
        'content-type': 'application/json',
        'content-length': body.length,
      });
      res.end(body);
    });
    const proxy = await startProxyServer(
      makeSettings(upstream.port, {
        interceptResponse: true,
        responseInterceptor:
          'const data = JSON.parse(responseParams.body.toString());\n' +
          'data.beta = true;\n' +
          'responseParams.body = JSON.stringify(data);',
      })
    );
    open.push(upstream.server, proxy.server);

    const res = await request({ port: proxy.port, path: '/' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString()).toBe('{"beta":true}');
    expect(res.headers['content-length']).toBe('13');
    expect(proxy.traffic.at(-1).interceptorErrors).toBeUndefined();
  });

  it('reaches the HTTP/1.1 path of the gRPC-mode listener too', async () => {
    const upstream = await startUpstream((req, res) =>
      res.end(`saw ${req.headers['x-tag'] ?? '-'}`)
    );
    const server = createHttp2ProxyServer({
      settings: makeSettings(upstream.port, { enableGrpc: true }),
      notify: () => {},
    });
    const port = await server.listen();
    open.push(upstream.server, server);
    server.setScripts({
      interceptRequest: true,
      requestInterceptor: "requestParams.headers['x-tag'] = 'h2'",
    });
    expect((await request({ port, path: '/' })).body.toString()).toBe('saw h2');
  });
});
