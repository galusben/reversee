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

// Replicates src/main.js:22 — the old app disables TLS verification globally
// so the proxy can reach self-signed upstreams. Replaced by a per-request
// rejectUnauthorized setting in milestone A5.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
    // Current behavior: the displayed body is lost on decode failure.
    // Milestone A5 changes this to keep the raw body + a decodeError flag.
    expect(traffic.response.body).toBeUndefined();
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
    expect(traffic.request.curl).toContain('curl-stub');
    expect(traffic.response.statusCode).toBe(200);
    expect(traffic.response.body.toString()).toBe('got request');
    expect(traffic.timings.start).toBeInstanceOf(Date);
    expect(traffic.timings.firstByte).toBeTypeOf('number');
    expect(traffic.timings.total).toBeTypeOf('number');
    expect(traffic.timings.total).toBeGreaterThanOrEqual(traffic.timings.firstByte);
  });
});
