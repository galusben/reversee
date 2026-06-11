// Headless safety-net tests for src/proxy.js, ported from the old Spectron
// suite (tests/reverse-proxy.js) plus coverage that suite never had
// (gzip, host rewrite, upstream errors, timings, request bodies).
import { describe, it, expect, afterEach } from 'vitest';
import zlib from 'node:zlib';
import {
  startUpstream,
  startProxyServer,
  request,
  closeAll,
  makeSettings,
} from './helpers.mjs';

let openServers = [];
afterEach(async () => {
  await closeAll(...openServers);
  openServers = [];
});

async function setup(upstreamHandler, { upstreamTls = false, settings: overrides = {} } = {}) {
  const upstream = await startUpstream(upstreamHandler, { tls: upstreamTls });
  const settings = makeSettings(upstream.port, {
    destProtocol: upstreamTls ? 'https' : 'http',
    ...overrides,
  });
  const proxyServer = await startProxyServer(settings);
  openServers.push(upstream.server, proxyServer.server);
  return { upstream, settings, proxyServer };
}

describe('proxy core', () => {
  it('proxies http to http', async () => {
    const { proxyServer } = await setup((req, res) => res.end('got request'));
    const res = await request({ port: proxyServer.port });
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('got request');
  });

  it('proxies https listener to https upstream', async () => {
    const { proxyServer } = await setup((req, res) => res.end('got request'), {
      upstreamTls: true,
      settings: { listenProtocol: 'https' },
    });
    const res = await request({ tls: true, port: proxyServer.port });
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('got request');
  });

  it('request interceptor adds a custom header', async () => {
    const { proxyServer } = await setup(
      (req, res) => {
        res.writeHead(200, { custom: req.headers['custom'] });
        res.end('got request');
      },
      {
        upstreamTls: true,
        settings: {
          listenProtocol: 'https',
          requestInterceptor: "requestParams.headers['custom']='custom val'",
          interceptRequest: true,
        },
      }
    );
    const res = await request({ tls: true, port: proxyServer.port });
    expect(res.headers['custom']).toBe('custom val');
    expect(res.body.toString()).toBe('got request');
  });

  // These two upstreams respond chunked (no content-length): the current proxy
  // copies the upstream content-length verbatim, so a body-replacing
  // interceptor desyncs the header and keep-alive clients hang. Fixed in A5,
  // which adds a content-length test.
  it('response interceptor sets header and body from request context', async () => {
    const { proxyServer } = await setup((req, res) => { res.writeHead(200); res.write('got request'); res.end(); }, {
      upstreamTls: true,
      settings: {
        listenProtocol: 'https',
        responseInterceptor:
          "responseParams.headers['custom']='custom val'; \n responseParams.body = requestParams.path",
        interceptResponse: true,
      },
    });
    const res = await request({ tls: true, port: proxyServer.port, path: '/bla' });
    expect(res.headers['custom']).toBe('custom val');
    expect(res.body.toString()).toBe('/bla');
  });

  it('response interceptor replaces the body', async () => {
    const { proxyServer } = await setup((req, res) => { res.writeHead(200); res.write('got request'); res.end(); }, {
      upstreamTls: true,
      settings: {
        listenProtocol: 'https',
        responseInterceptor: "responseParams.body='custom val'",
        interceptResponse: true,
      },
    });
    const res = await request({ tls: true, port: proxyServer.port });
    expect(res.body.toString()).toBe('custom val');
  });

  it('leaves a relative redirect location untouched', async () => {
    const { proxyServer } = await setup(
      (req, res) => {
        res.writeHead(302, { location: '/bla/' });
        res.end('got request');
      },
      { upstreamTls: true, settings: { listenProtocol: 'https', redirect: true } }
    );
    const res = await request({ tls: true, port: proxyServer.port });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/bla/');
    expect(res.body.toString()).toBe('got request');
  });

  it('rewrites an absolute redirect location to the listen host and protocol', async () => {
    const { proxyServer } = await setup(
      (req, res) => {
        res.writeHead(302, { location: 'http://bad.host.com/bla/' });
        res.end('got request');
      },
      { upstreamTls: true, settings: { listenProtocol: 'https', redirect: true } }
    );
    const res = await request({ tls: true, port: proxyServer.port });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`https://127.0.0.1:${proxyServer.port}/bla/`);
  });

  it('does not rewrite absolute redirects when the redirect setting is off', async () => {
    const { proxyServer } = await setup(
      (req, res) => {
        res.writeHead(302, { location: 'http://bad.host.com/bla/' });
        res.end('got request');
      },
      { settings: { redirect: false } }
    );
    const res = await request({ port: proxyServer.port });
    expect(res.headers.location).toBe('http://bad.host.com/bla/');
  });

  it('rewrites the host header when hostRewrite is on', async () => {
    let seenHost;
    const { upstream, proxyServer } = await setup((req, res) => {
      seenHost = req.headers.host;
      res.end('ok');
    }, { settings: { hostRewrite: true } });
    await request({ port: proxyServer.port });
    expect(seenHost).toBe(`127.0.0.1:${upstream.port}`);
  });

  it('preserves the client host header when hostRewrite is off', async () => {
    let seenHost;
    const { proxyServer } = await setup((req, res) => {
      seenHost = req.headers.host;
      res.end('ok');
    });
    await request({ port: proxyServer.port });
    expect(seenHost).toBe(`127.0.0.1:${proxyServer.port}`);
  });

  it('forwards request bodies to the upstream', async () => {
    let seenBody;
    let seenMethod;
    const { proxyServer } = await setup((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seenBody = Buffer.concat(chunks).toString();
        seenMethod = req.method;
        res.end('ok');
      });
    });
    await request({ port: proxyServer.port, method: 'POST', body: 'hello body' });
    expect(seenMethod).toBe('POST');
    expect(seenBody).toBe('hello body');
  });

  it('passes gzip responses through unmodified and decodes them for the traffic view', async () => {
    const gzipped = zlib.gzipSync('hello gzip');
    const { proxyServer } = await setup((req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(gzipped);
    });
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.equals(gzipped)).toBe(true);
    const traffic = await trafficPromise;
    expect(traffic.response.body.toString()).toBe('hello gzip');
  });

  it('still delivers the wire body when gzip decoding fails', async () => {
    const notActuallyGzip = Buffer.from('plain text lying about its encoding');
    const { proxyServer } = await setup((req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(notActuallyGzip);
    });
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port });
    expect(res.body.equals(notActuallyGzip)).toBe(true);
    const traffic = await trafficPromise;
    expect(traffic.response.body.equals(notActuallyGzip)).toBe(true);
    expect(traffic.response.decodeError).toBeTruthy();
  });

  it('decodes brotli responses for the traffic view', async () => {
    const compressed = zlib.brotliCompressSync('hello brotli');
    const { proxyServer } = await setup((req, res) => {
      res.writeHead(200, { 'content-encoding': 'br' });
      res.end(compressed);
    });
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port });
    expect(res.body.equals(compressed)).toBe(true);
    const traffic = await trafficPromise;
    expect(traffic.response.body.toString()).toBe('hello brotli');
  });

  it('updates content-length when a response interceptor replaces a fixed-length body', async () => {
    const { proxyServer } = await setup((req, res) => res.end('got request'), {
      settings: {
        responseInterceptor: "responseParams.body='replaced body that is much longer than the original'",
        interceptResponse: true,
      },
    });
    const res = await request({ port: proxyServer.port });
    expect(res.body.toString()).toBe('replaced body that is much longer than the original');
    expect(res.headers['content-length']).toBe(String(res.body.length));
  });

  it('reaches self-signed upstreams by default', async () => {
    const { proxyServer } = await setup((req, res) => res.end('ok'), {
      upstreamTls: true,
    });
    const res = await request({ port: proxyServer.port });
    expect(res.statusCode).toBe(200);
  });

  it('rejects self-signed upstreams when allowSelfSignedUpstream is false', async () => {
    const { proxyServer } = await setup((req, res) => res.end('ok'), {
      upstreamTls: true,
      settings: { allowSelfSignedUpstream: false },
    });
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port });
    expect(res.statusCode).toBe(502);
    const traffic = await trafficPromise;
    expect(String(traffic.connectorError)).toMatch(/self.signed|certificate/i);
  });

  it('responds 502 and reports connectorError when the upstream is unreachable', async () => {
    const upstream = await startUpstream((req, res) => res.end('ok'));
    const settings = makeSettings(upstream.port);
    await closeAll(upstream.server); // kill upstream so connections fail
    const proxyServer = await startProxyServer(settings);
    openServers.push(proxyServer.server);

    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port });
    expect(res.statusCode).toBe(502);
    const traffic = await trafficPromise;
    expect(traffic.connectorError).toBeTruthy();
    expect(traffic.response.statusCode).toBe(502);
  });

  it('holds gated requests and forwards the edited params on resume', async () => {
    let seenHeader;
    const upstream = await startUpstream((req, res) => {
      seenHeader = req.headers['x-edited'];
      res.end('ok');
    });
    let release;
    const gate = (req, body) =>
      req.url === '/hold'
        ? new Promise((resolve) => {
            release = () =>
              resolve({ body, headers: { ...req.headers, 'x-edited': 'by breakpoint' } });
          })
        : null;
    const settings = makeSettings(upstream.port);
    const proxyServer = await startProxyServer(settings, { gate });
    openServers.push(upstream.server, proxyServer.server);

    const resPromise = request({ port: proxyServer.port, path: '/hold' });
    await new Promise((r) => setTimeout(r, 50));
    expect(seenHeader).toBeUndefined(); // still held
    release();
    const res = await resPromise;
    expect(res.statusCode).toBe(200);
    expect(seenHeader).toBe('by breakpoint');
  });

  it('records traffic with request view, response view, curl and timings', async () => {
    const { proxyServer } = await setup((req, res) => res.end('got request'), {
      settings: { dest: 'localhost' },
    });
    const trafficPromise = proxyServer.nextTraffic();
    await request({ port: proxyServer.port, path: '/timed' });
    const traffic = await trafficPromise;

    expect(traffic.trafficId).toBeTypeOf('number');
    expect(traffic.request.url).toBe('/timed');
    expect(traffic.request.method).toBe('GET');
    expect(traffic.request.curl).toContain("curl -X GET 'http://localhost:");
    expect(traffic.request.curl).toContain('/timed');
    expect(traffic.response.statusCode).toBe(200);
    expect(traffic.response.body.toString()).toBe('got request');
    expect(traffic.timings.start).toBeInstanceOf(Date);
    expect(traffic.timings.firstByte).toBeTypeOf('number');
    expect(traffic.timings.total).toBeTypeOf('number');
    expect(traffic.timings.total).toBeGreaterThanOrEqual(traffic.timings.firstByte);
  });
});
