// Mock rules, route rules, upstream mutual TLS, and response breakpoints,
// through the real proxy server against real fixture upstreams.
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import https from 'node:https';
import zlib from 'node:zlib';
import forge from 'node-forge';
import { startUpstream, startProxyServer, request, closeAll, makeSettings } from './helpers.mjs';
import { compileRules, matchRoute, matchMock, hostWithoutPort } from '../../src/proxy/core/rules';

let openServers = [];
afterEach(async () => {
  await closeAll(...openServers);
  openServers = [];
});

const mock = (overrides) => ({
  id: 'm1',
  enabled: true,
  pathPattern: '^/mocked',
  statusCode: 200,
  headers: {},
  body: '',
  ...overrides,
});

const route = (overrides) => ({
  id: 'r1',
  enabled: true,
  destProtocol: 'http',
  dest: '127.0.0.1',
  destPort: 1,
  ...overrides,
});

describe('rule compilation and matching', () => {
  it('skips disabled rules and rules whose pattern does not compile', () => {
    const warnings = [];
    const rules = compileRules(
      {
        routes: [
          route({ id: 'off', enabled: false }),
          route({ id: 'bad', pathPattern: '(' }),
          route({ id: 'ok', pathPattern: '^/api' }),
        ],
        mocks: [mock({ id: 'bad', pathPattern: '[' }), mock({ id: 'ok' })],
      },
      { debug() {}, info() {}, error() {}, warn: (...a) => warnings.push(a[0]) }
    );
    expect(rules.routes.map((r) => r.rule.id)).toEqual(['ok']);
    expect(rules.mocks.map((m) => m.rule.id)).toEqual(['ok']);
    expect(warnings).toHaveLength(2);
  });

  it('routes on host and path together, first match wins', () => {
    const rules = compileRules({
      routes: [
        route({ id: 'img', hostPattern: '^img\\.', dest: 'images' }),
        route({ id: 'api-v2', pathPattern: '^/api/v2/', dest: 'v2' }),
        route({ id: 'api', pathPattern: '^/api/', dest: 'v1' }),
        route({ id: 'both', hostPattern: '^admin\\.', pathPattern: '^/x', dest: 'admin' }),
      ],
    });
    expect(matchRoute(rules, 'img.example.com:8000', '/logo.png')?.id).toBe('img');
    expect(matchRoute(rules, 'IMG.example.com', '/logo.png')?.id).toBe('img'); // hosts are case-insensitive
    expect(matchRoute(rules, 'example.com', '/api/v2/users')?.id).toBe('api-v2');
    expect(matchRoute(rules, 'example.com', '/api/users')?.id).toBe('api');
    expect(matchRoute(rules, 'admin.example.com', '/x/1')?.id).toBe('both');
    expect(matchRoute(rules, 'admin.example.com', '/y')).toBeNull();
    expect(matchRoute(rules, undefined, '/other')).toBeNull();
  });

  it('a rule without patterns matches everything', () => {
    const rules = compileRules({ routes: [route({ id: 'all' })] });
    expect(matchRoute(rules, 'anything', '/')?.id).toBe('all');
  });

  it('strips the port from a host header', () => {
    expect(hostWithoutPort('example.com:8080')).toBe('example.com');
    expect(hostWithoutPort('example.com')).toBe('example.com');
    expect(hostWithoutPort('[::1]:8080')).toBe('[::1]');
    expect(hostWithoutPort(undefined)).toBe('');
  });

  it('mocks match on method (when given) and URL', () => {
    const rules = compileRules({
      mocks: [mock({ id: 'post', method: 'POST', pathPattern: '^/items$' }), mock({ id: 'any' })],
    });
    expect(matchMock(rules, 'POST', '/items')?.id).toBe('post');
    expect(matchMock(rules, 'post', '/items')?.id).toBe('post');
    expect(matchMock(rules, 'GET', '/items')).toBeNull();
    expect(matchMock(rules, 'DELETE', '/mocked/1')?.id).toBe('any');
  });
});

describe('mock rules', () => {
  it('answers from the rule without contacting the upstream', async () => {
    let upstreamHits = 0;
    const upstream = await startUpstream((req, res) => {
      upstreamHits++;
      res.end('real');
    });
    const proxyServer = await startProxyServer(
      makeSettings(upstream.port, {
        mocks: [
          mock({
            pathPattern: '^/api/flag',
            statusCode: 418,
            headers: { 'content-type': 'application/json', 'x-mock': 'yes' },
            body: '{"teapot":true}',
          }),
        ],
      })
    );
    openServers.push(upstream.server, proxyServer.server);

    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port, path: '/api/flag?x=1' });
    expect(res.statusCode).toBe(418);
    expect(res.headers['x-mock']).toBe('yes');
    expect(res.headers['content-length']).toBe('15');
    expect(res.body.toString()).toBe('{"teapot":true}');
    expect(upstreamHits).toBe(0);

    const traffic = await trafficPromise;
    expect(traffic.mocked).toBe(true);
    expect(traffic.response.statusCode).toBe(418);
    expect(traffic.response.body.toString()).toBe('{"teapot":true}');
    expect(traffic.request.target).toBeUndefined();

    // Everything else still reaches the upstream.
    expect((await request({ port: proxyServer.port, path: '/other' })).body.toString()).toBe(
      'real'
    );
    expect(upstreamHits).toBe(1);
  });

  it('applies the configured delay', async () => {
    const upstream = await startUpstream((req, res) => res.end('real'));
    const proxyServer = await startProxyServer(
      makeSettings(upstream.port, { mocks: [mock({ body: 'late', delayMs: 200 })] })
    );
    openServers.push(upstream.server, proxyServer.server);
    const started = Date.now();
    const res = await request({ port: proxyServer.port, path: '/mocked' });
    expect(res.body.toString()).toBe('late');
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('skips interceptors for mocked responses', async () => {
    const upstream = await startUpstream((req, res) => res.end('real'));
    const proxyServer = await startProxyServer(
      makeSettings(upstream.port, {
        mocks: [mock({ body: 'canned' })],
        interceptResponse: true,
        responseInterceptor: "responseParams.body = 'intercepted'",
      })
    );
    openServers.push(upstream.server, proxyServer.server);
    expect((await request({ port: proxyServer.port, path: '/mocked' })).body.toString()).toBe(
      'canned'
    );
    expect((await request({ port: proxyServer.port, path: '/real' })).body.toString()).toBe(
      'intercepted'
    );
  });
});

describe('route rules', () => {
  it('sends matching requests to another upstream and rewrites Host to it', async () => {
    const seen = {};
    const main = await startUpstream((req, res) => {
      seen.main = req.headers.host;
      res.end('main');
    });
    const other = await startUpstream((req, res) => {
      seen.other = req.headers.host;
      res.end('other');
    });
    const proxyServer = await startProxyServer(
      makeSettings(main.port, {
        hostRewrite: true,
        routes: [route({ pathPattern: '^/v2/', destPort: other.port })],
      })
    );
    openServers.push(main.server, other.server, proxyServer.server);

    const trafficPromise = proxyServer.nextTraffic();
    expect((await request({ port: proxyServer.port, path: '/v2/users' })).body.toString()).toBe(
      'other'
    );
    const traffic = await trafficPromise;
    expect(traffic.request.target).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: other.port,
    });
    expect(traffic.request.curl).toContain(`http://127.0.0.1:${other.port}/v2/users`);
    expect(seen.other).toBe(`127.0.0.1:${other.port}`);

    expect((await request({ port: proxyServer.port, path: '/v1/users' })).body.toString()).toBe(
      'main'
    );
    expect(seen.main).toBe(`127.0.0.1:${main.port}`);
  });

  it('routes by Host header and can switch protocol to https', async () => {
    const main = await startUpstream((req, res) => res.end('main'));
    const secure = await startUpstream((req, res) => res.end('secure'), { tls: true });
    const proxyServer = await startProxyServer(
      makeSettings(main.port, {
        routes: [
          route({ hostPattern: '^secure\\.local$', destProtocol: 'https', destPort: secure.port }),
        ],
      })
    );
    openServers.push(main.server, secure.server, proxyServer.server);

    const routed = await request({ port: proxyServer.port, headers: { host: 'secure.local:9' } });
    expect(routed.body.toString()).toBe('secure');
    const plain = await request({ port: proxyServer.port, headers: { host: 'plain.local' } });
    expect(plain.body.toString()).toBe('main');
  });

  it('lets a request interceptor override the routed target', async () => {
    const main = await startUpstream((req, res) => res.end('main'));
    const third = await startUpstream((req, res) => res.end('third'));
    const proxyServer = await startProxyServer(
      makeSettings(main.port, {
        routes: [route({ destPort: 1 })], // would fail if used
        interceptRequest: true,
        requestInterceptor: `requestParams.port = ${third.port}`,
      })
    );
    openServers.push(main.server, third.server, proxyServer.server);
    expect((await request({ port: proxyServer.port })).body.toString()).toBe('third');
  });
});

describe('upstream mutual TLS', () => {
  let ca;
  let client;

  // A throwaway CA and a client certificate signed by it.
  beforeAll(() => {
    const make = (cn, issuer, issuerKey, isCa) => {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = String(Date.now()) + (isCa ? '1' : '2');
      cert.validity.notBefore = new Date(Date.now() - 60_000);
      cert.validity.notAfter = new Date(Date.now() + 3_600_000);
      const subject = [{ name: 'commonName', value: cn }];
      cert.setSubject(subject);
      cert.setIssuer(issuer ?? subject);
      cert.setExtensions(
        isCa
          ? [{ name: 'basicConstraints', cA: true }]
          : [{ name: 'extKeyUsage', clientAuth: true }]
      );
      cert.sign(issuerKey ?? keys.privateKey, forge.md.sha256.create());
      return {
        cert: forge.pki.certificateToPem(cert),
        key: forge.pki.privateKeyToPem(keys.privateKey),
        subject,
        privateKey: keys.privateKey,
      };
    };
    ca = make('Test Client CA', null, null, true);
    client = make('reversee-client', ca.subject, ca.privateKey, false);
  }, 60_000);

  async function startMtlsUpstream() {
    const { sslOptions } = await import('./helpers.mjs');
    const server = https.createServer(
      { ...sslOptions, requestCert: true, rejectUnauthorized: true, ca: ca.cert },
      (req, res) => res.end(`hello ${req.socket.getPeerCertificate().subject.CN}`)
    );
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, port: server.address().port };
  }

  it('presents the configured client certificate', async () => {
    const upstream = await startMtlsUpstream();
    const proxyServer = await startProxyServer(
      makeSettings(upstream.port, {
        destProtocol: 'https',
        upstreamClientCert: { cert: client.cert, key: client.key },
      })
    );
    openServers.push(upstream.server, proxyServer.server);
    const res = await request({ port: proxyServer.port });
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('hello reversee-client');
  });

  it('fails with a 502 when the upstream demands a certificate and none is configured', async () => {
    const upstream = await startMtlsUpstream();
    const proxyServer = await startProxyServer(
      makeSettings(upstream.port, { destProtocol: 'https' })
    );
    openServers.push(upstream.server, proxyServer.server);
    const res = await request({ port: proxyServer.port });
    expect(res.statusCode).toBe(502);
  });
});

describe('response breakpoints', () => {
  function makeGate(pattern) {
    const held = [];
    return {
      held,
      gate: {
        matches: ({ url }) => pattern.test(url),
        hold: (req, res) =>
          new Promise((resolve) => held.push({ request: req, response: res, resume: resolve })),
      },
    };
  }
  const until = async (cond) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };

  it('holds the response until resumed and applies the edits', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-keep': '1' });
      res.end('original');
    });
    const { held, gate } = makeGate(/^\/held/);
    const proxyServer = await startProxyServer(makeSettings(upstream.port), { responseGate: gate });
    openServers.push(upstream.server, proxyServer.server);

    let settled = false;
    const trafficPromise = proxyServer.nextTraffic();
    const pending = request({ port: proxyServer.port, path: '/held/1' }).then((r) => {
      settled = true;
      return r;
    });
    await until(() => held.length === 1);
    expect(settled).toBe(false); // the client is still waiting
    expect(held[0].request).toEqual({ url: '/held/1', method: 'GET' });
    expect(held[0].response.statusCode).toBe(200);
    expect(held[0].response.body.toString()).toBe('original');

    held[0].resume({
      statusCode: 503,
      headers: { 'content-type': 'text/plain', 'x-edited': 'yes', 'content-length': '8' },
      body: 'edited by the user',
    });
    const res = await pending;
    expect(res.statusCode).toBe(503);
    expect(res.headers['x-edited']).toBe('yes');
    expect(res.headers['x-keep']).toBeUndefined();
    expect(res.body.toString()).toBe('edited by the user');
    expect(res.headers['content-length']).toBe('18'); // resynced to the edit

    const traffic = await trafficPromise;
    expect(traffic.response.statusCode).toBe(503);
    expect(traffic.response.body.toString()).toBe('edited by the user');
  });

  it('passes the response through unchanged when resumed without edits', async () => {
    const upstream = await startUpstream((req, res) => res.end('as is'));
    const { held, gate } = makeGate(/./);
    const proxyServer = await startProxyServer(makeSettings(upstream.port), { responseGate: gate });
    openServers.push(upstream.server, proxyServer.server);
    const pending = request({ port: proxyServer.port });
    await until(() => held.length === 1);
    held[0].resume({});
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('as is');
  });

  it('streams responses that do not match', async () => {
    const upstream = await startUpstream((req, res) => res.end('free'));
    const { held, gate } = makeGate(/^\/held/);
    const proxyServer = await startProxyServer(makeSettings(upstream.port), { responseGate: gate });
    openServers.push(upstream.server, proxyServer.server);
    expect((await request({ port: proxyServer.port, path: '/free' })).body.toString()).toBe('free');
    expect(held).toHaveLength(0);
  });

  it('hands over a compressed body decompressed, and sends the edit uncompressed', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
      res.end(zlib.gzipSync('{"compressed":true}'));
    });
    const { held, gate } = makeGate(/./);
    const proxyServer = await startProxyServer(makeSettings(upstream.port), { responseGate: gate });
    openServers.push(upstream.server, proxyServer.server);

    const pending = request({ port: proxyServer.port });
    await until(() => held.length === 1);
    expect(held[0].response.body.toString()).toBe('{"compressed":true}');
    expect(held[0].response.headers['content-encoding']).toBeUndefined();
    held[0].resume({ headers: held[0].response.headers, body: '{"compressed":false}' });

    const res = await pending;
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.toString()).toBe('{"compressed":false}');
  });

  it('drops the held response when the client gives up', async () => {
    const upstream = await startUpstream((req, res) => res.end('late'));
    const { held, gate } = makeGate(/./);
    const proxyServer = await startProxyServer(makeSettings(upstream.port), { responseGate: gate });
    openServers.push(upstream.server, proxyServer.server);

    const trafficPromise = proxyServer.nextTraffic();
    const http = await import('node:http');
    const req = http.get({ hostname: '127.0.0.1', port: proxyServer.port, path: '/x' });
    req.on('error', () => {});
    await until(() => held.length === 1);
    req.destroy();
    const traffic = await trafficPromise;
    expect(traffic.clientAborted).toBe(true);
    held[0].resume({ body: 'nobody is listening' }); // must not throw or double-record
    await new Promise((r) => setTimeout(r, 30));
    expect(proxyServer.traffic).toHaveLength(1);
  });
});
