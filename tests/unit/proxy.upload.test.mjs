// Request bodies (#44): streamed upstream as they arrive when nothing has to
// see them whole, buffered (up to a ceiling, then 413) when a request
// breakpoint or the request interceptor does, and a client that disconnects
// mid-upload stops the upstream request.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { startUpstream, startProxyServer, request, closeAll, makeSettings } from './helpers.mjs';

let openServers = [];
afterEach(async () => {
  await closeAll(...openServers);
  openServers = [];
});

async function setup(upstreamHandler, { settings: overrides = {}, ...proxyOptions } = {}) {
  const upstream = await startUpstream(upstreamHandler);
  const settings = makeSettings(upstream.port, overrides);
  const proxyServer = await startProxyServer(settings, proxyOptions);
  openServers.push(upstream.server, proxyServer.server);
  return { upstream, settings, proxyServer };
}

/** An upstream that hashes the body it receives and answers with its size. */
function hashingUpstream(seen) {
  return (req, res) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    seen.headers = req.headers;
    req.on('data', (c) => {
      hash.update(c);
      size += c.length;
    });
    req.on('end', () => {
      seen.sha256 = hash.digest('hex');
      seen.size = size;
      res.end(String(size));
    });
  };
}

/**
 * Starts a POST whose body the test writes itself. Resolves the response (or
 * the error, when the proxy hung up mid-upload) via `result`.
 */
function startUpload(port, { path = '/upload', headers = {} } = {}) {
  const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers });
  const result = new Promise((resolve) => {
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
      res.on('error', (error) => resolve({ error }));
    });
    req.on('error', (error) => resolve({ error }));
  });
  return { req, result };
}

describe('streamed uploads', () => {
  it('forwards a large upload byte for byte and keeps only a bounded copy', async () => {
    const seen = {};
    const { proxyServer } = await setup(hashingUpstream(seen), { captureLimit: 64 * 1024 });
    const chunk = crypto.randomBytes(64 * 1024);
    const count = 384; // 24 MB
    const size = chunk.length * count;
    const expected = crypto.createHash('sha256');
    for (let i = 0; i < count; i++) expected.update(chunk);

    const trafficPromise = proxyServer.nextTraffic();
    const { req, result } = startUpload(proxyServer.port, {
      headers: { 'content-length': String(size) },
    });
    let written = 0;
    const pump = () => {
      while (written < count) {
        written++;
        if (!req.write(chunk)) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
    const res = await result;
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe(String(size));
    expect(seen.size).toBe(size);
    expect(seen.sha256).toBe(expected.digest('hex'));
    // Framing is passed through as the client sent it.
    expect(seen.headers['content-length']).toBe(String(size));

    const traffic = await trafficPromise;
    expect(traffic.request.size).toBe(size);
    expect(traffic.request.body.length).toBe(64 * 1024);
    expect(traffic.request.truncated).toBe(true);
    expect(Buffer.compare(Buffer.from(traffic.request.body), chunk)).toBe(0);
    // The command points at a file instead of inlining a partial body.
    expect(traffic.request.curl).toContain("--data-binary '@request-body.bin'");
  }, 20_000);

  it('sends the first bytes upstream before the client has finished sending', async () => {
    let firstBytes;
    const gotFirst = new Promise((resolve) => (firstBytes = resolve));
    const { proxyServer } = await setup((req, res) => {
      const chunks = [];
      req.on('data', (c) => {
        if (!chunks.length) firstBytes(c.toString());
        chunks.push(c);
      });
      req.on('end', () => res.end(Buffer.concat(chunks)));
    });

    const trafficPromise = proxyServer.nextTraffic();
    const { req, result } = startUpload(proxyServer.port, {
      headers: { 'transfer-encoding': 'chunked' },
    });
    req.write('first;');
    // The upstream sees this while the client still holds the rest back.
    expect(await gotFirst).toBe('first;');
    req.end('rest');
    const res = await result;
    expect(res.body.toString()).toBe('first;rest');

    const traffic = await trafficPromise;
    expect(Buffer.from(traffic.request.body).toString()).toBe('first;rest');
    expect(traffic.request.size).toBe(10);
    expect(traffic.request.truncated).toBeUndefined();
    expect(traffic.request.curl).toContain("--data-binary 'first;rest'");
  });

  it('records a small body and its curl as before', async () => {
    const { proxyServer } = await setup((req, res) => {
      req.resume();
      req.on('end', () => res.end('ok'));
    });
    const trafficPromise = proxyServer.nextTraffic();
    await request({ port: proxyServer.port, method: 'POST', path: '/small', body: 'a=1' });
    const traffic = await trafficPromise;
    expect(Buffer.from(traffic.request.body).toString()).toBe('a=1');
    expect(traffic.request.size).toBe(3);
    expect(traffic.request.curl).toMatch(/^curl -X POST '.*\/small'/);
    expect(traffic.request.curl).toContain("--data-binary 'a=1'");
  });

  it('honours Expect: 100-continue', async () => {
    const seen = {};
    const { proxyServer } = await setup(hashingUpstream(seen));
    const body = crypto.randomBytes(100 * 1024);
    const { req, result } = startUpload(proxyServer.port, {
      headers: { expect: '100-continue', 'content-length': String(body.length) },
    });
    req.on('continue', () => req.end(body));
    const res = await result;
    expect(res.statusCode).toBe(200);
    expect(seen.size).toBe(body.length);
    expect(seen.sha256).toBe(crypto.createHash('sha256').update(body).digest('hex'));
  });

  it('starts the upstream header timeout only once the upload is complete', async () => {
    const { proxyServer } = await setup(
      (req, res) => {
        req.resume();
        req.on('end', () => res.end('done'));
      },
      { settings: { upstreamTimeoutSec: 1 } }
    );
    const { req, result } = startUpload(proxyServer.port, {
      headers: { 'transfer-encoding': 'chunked' },
    });
    req.write('slow ');
    await new Promise((r) => setTimeout(r, 1300));
    req.end('upload');
    const res = await result;
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('done');
  });

  it('stops the upstream request when the client disconnects mid-upload', async () => {
    let upstreamGotData;
    const gotData = new Promise((resolve) => (upstreamGotData = resolve));
    let upstreamClosed;
    const closed = new Promise((resolve) => (upstreamClosed = resolve));
    const { proxyServer } = await setup((req) => {
      req.once('data', () => upstreamGotData());
      req.on('close', () => upstreamClosed(req.complete));
    });

    const trafficPromise = proxyServer.nextTraffic();
    const { req } = startUpload(proxyServer.port, {
      headers: { 'content-length': String(1024 * 1024) },
    });
    req.on('error', () => {});
    req.write(Buffer.alloc(16 * 1024, 'x'));
    await gotData;
    req.destroy();

    // The upstream sees an incomplete request torn down, not a hang.
    expect(await closed).toBe(false);
    const traffic = await trafficPromise;
    expect(traffic.clientAborted).toBe(true);
    expect(traffic.pending).toBeUndefined();
    expect(traffic.request.size).toBe(16 * 1024);
    expect(traffic.request.curl).toContain("--data-binary '@request-body.bin'");
  });

  it('answers 502 when the upstream drops the connection mid-upload', async () => {
    const { proxyServer } = await setup((req) => {
      req.once('data', () => req.socket.destroy());
    });
    const trafficPromise = proxyServer.nextTraffic();
    const { req, result } = startUpload(proxyServer.port, {
      headers: { 'transfer-encoding': 'chunked' },
    });
    req.write(Buffer.alloc(1024, 'x'));
    const traffic = await trafficPromise;
    expect(traffic.response.statusCode).toBe(502);
    expect(traffic.connectorError).toBeTruthy();
    // The client gets the explanation, and the connection closes on its unread upload.
    const res = await result;
    expect(res.statusCode).toBe(502);
    expect(res.headers['connection']).toBe('close');
    req.destroy();
  });

  it('serves a mock after reading the streamed body for the view', async () => {
    let upstreamHits = 0;
    const { proxyServer } = await setup(
      (req, res) => {
        upstreamHits++;
        res.end('real');
      },
      {
        settings: {
          mocks: [
            {
              id: 'm1',
              enabled: true,
              pathPattern: '^/mocked',
              statusCode: 201,
              headers: {},
              body: 'mocked',
            },
          ],
        },
      }
    );
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({
      port: proxyServer.port,
      method: 'POST',
      path: '/mocked',
      body: 'the whole body',
    });
    expect(res.statusCode).toBe(201);
    expect(res.body.toString()).toBe('mocked');
    expect(upstreamHits).toBe(0);
    const traffic = await trafficPromise;
    expect(traffic.mocked).toBe(true);
    expect(Buffer.from(traffic.request.body).toString()).toBe('the whole body');
    expect(traffic.request.size).toBe(14);
  });
});

describe('buffered uploads (breakpoints, request interceptor)', () => {
  it('a request breakpoint still gets the whole body; others are streamed past it', async () => {
    const seen = {};
    const gateBodies = [];
    const gate = (req, body) => {
      gateBodies.push(body.toString());
      return Promise.resolve({ body: Buffer.concat([body, Buffer.from('+edited')]) });
    };
    gate.matches = (req) => req.url === '/hold';
    let echoed;
    const { proxyServer } = await setup(
      (req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          echoed = Buffer.concat(chunks).toString();
          seen.contentLength = req.headers['content-length'];
          res.end(echoed);
        });
      },
      { gate }
    );

    const { req, result } = startUpload(proxyServer.port, {
      path: '/hold',
      headers: { 'content-length': '9' },
    });
    req.end('held body');
    const res = await result;
    expect(gateBodies).toEqual(['held body']);
    expect(res.body.toString()).toBe('held body+edited');
    // The edited body goes out with a content-length that matches it.
    expect(seen.contentLength).toBe(String('held body+edited'.length));

    // No breakpoint matches: the gate is not consulted, the body streams.
    await request({ port: proxyServer.port, method: 'POST', path: '/other', body: 'streamed' });
    expect(gateBodies).toEqual(['held body']);
    expect(echoed).toBe('streamed');
  });

  it('a gate without matches() keeps every request buffered for it', async () => {
    const gateBodies = [];
    const gate = (req, body) => {
      gateBodies.push(body.toString());
      return null;
    };
    const { proxyServer } = await setup(
      (req, res) => {
        req.resume();
        req.on('end', () => res.end('ok'));
      },
      { gate }
    );
    await request({ port: proxyServer.port, method: 'POST', body: 'abc' });
    expect(gateBodies).toEqual(['abc']);
  });

  it('the request interceptor still sees the whole body', async () => {
    const body = crypto.randomBytes(512 * 1024);
    let lengthHeader;
    const { proxyServer } = await setup(
      (req, res) => {
        lengthHeader = req.headers['x-body-length'];
        req.resume();
        req.on('end', () => res.end('ok'));
      },
      {
        settings: {
          requestInterceptor:
            "requestParams.headers['x-body-length'] = String(requestParams.body.length)",
          interceptRequest: true,
        },
      }
    );
    const res = await request({ port: proxyServer.port, method: 'POST', body });
    expect(res.statusCode).toBe(200);
    expect(lengthHeader).toBe(String(body.length));
  });

  it('refuses a body past the limit with a 413, upfront when content-length says so', async () => {
    let upstreamHits = 0;
    const { proxyServer } = await setup(
      (req, res) => {
        upstreamHits++;
        res.end('real');
      },
      {
        maxBufferedBody: 1024,
        settings: { requestInterceptor: 'void 0', interceptRequest: true },
      }
    );
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({
      port: proxyServer.port,
      method: 'POST',
      path: '/big',
      body: Buffer.alloc(2048, 'y'),
    });
    expect(res.statusCode).toBe(413);
    expect(res.headers['x-reversee-error']).toBe('REQUEST_BODY_TOO_LARGE');
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['connection']).toBe('close');
    expect(res.body.toString()).toContain('too large to hold in memory');
    expect(res.body.toString()).toContain('1024 bytes');
    expect(upstreamHits).toBe(0);

    const traffic = await trafficPromise;
    expect(traffic.response.statusCode).toBe(413);
    expect(traffic.request.size).toBe(2048);
    expect(traffic.request.truncated).toBe(true);
    expect(traffic.request.url).toBe('/big');
  });

  it('refuses a chunked body once it grows past the limit, and the gate never sees it', async () => {
    let upstreamHits = 0;
    let gateCalls = 0;
    const gate = () => {
      gateCalls++;
      return null;
    };
    gate.matches = () => true;
    const { proxyServer } = await setup(
      (req, res) => {
        upstreamHits++;
        res.end('real');
      },
      { gate, maxBufferedBody: 4096, captureLimit: 1000 }
    );
    const trafficPromise = proxyServer.nextTraffic();
    const { req, result } = startUpload(proxyServer.port, {
      headers: { 'transfer-encoding': 'chunked' },
    });
    // Keeps sending, as an endless upload would, until the proxy answers.
    const timer = setInterval(() => {
      if (!req.destroyed) req.write(Buffer.alloc(1024, 'z'));
    }, 5);
    const res = await result;
    clearInterval(timer);
    req.destroy();
    expect(res.statusCode).toBe(413);
    expect(res.headers['x-reversee-error']).toBe('REQUEST_BODY_TOO_LARGE');
    expect(upstreamHits).toBe(0);
    expect(gateCalls).toBe(0);

    const traffic = await trafficPromise;
    expect(traffic.response.statusCode).toBe(413);
    expect(traffic.request.size).toBeGreaterThan(4096);
    expect(traffic.request.body.length).toBe(1000);
    expect(traffic.request.truncated).toBe(true);
  });

  it('streams past the limit when nothing needs the body buffered', async () => {
    const seen = {};
    const { proxyServer } = await setup(hashingUpstream(seen), { maxBufferedBody: 1024 });
    const body = crypto.randomBytes(64 * 1024);
    const res = await request({ port: proxyServer.port, method: 'POST', body });
    expect(res.statusCode).toBe(200);
    expect(seen.size).toBe(body.length);
  });
});
