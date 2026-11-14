// Streaming, resilience and error-reporting behaviour of the proxy core:
// responses reach the client as they arrive (SSE, large bodies), the capture
// for the traffic view stays bounded, a hung upstream times out, an aborted
// client stops the upstream work, and failures are explained in the 502/504.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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

/** Opens a request and resolves as soon as the response HEAD arrives. */
function open(port, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => resolve({ req, res }));
    req.on('error', reject);
  });
}

function nextChunk(res) {
  return new Promise((resolve) => res.once('data', (c) => resolve(c.toString())));
}

describe('response streaming', () => {
  it('delivers server-sent events as they are produced, not when the stream ends', async () => {
    let sendSecond;
    const { proxyServer } = await setup((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      sendSecond = () => res.end('data: second\n\n');
    });

    const { res } = await open(proxyServer.port, '/events');
    expect(res.headers['content-type']).toBe('text/event-stream');
    // The first event arrives while the upstream response is still open.
    expect(await nextChunk(res)).toBe('data: first\n\n');
    expect(sendSecond).toBeTypeOf('function');

    const done = proxyServer.nextTraffic();
    sendSecond();
    expect(await nextChunk(res)).toBe('data: second\n\n');
    const traffic = await done;
    expect(traffic.response.body.toString()).toBe('data: first\n\ndata: second\n\n');
    expect(traffic.pending).toBeUndefined();
  });

  it('sends the response head before any body byte exists', async () => {
    let finish;
    const { proxyServer } = await setup((req, res) => {
      res.writeHead(201, { 'x-early': 'yes' });
      res.flushHeaders();
      finish = () => res.end('late body');
    });
    const { res } = await open(proxyServer.port);
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-early']).toBe('yes');
    finish();
    expect(await nextChunk(res)).toBe('late body');
  });

  it('streams a large body intact and keeps only a bounded copy for the view', async () => {
    const size = 24 * 1024 * 1024;
    const chunk = crypto.randomBytes(64 * 1024);
    const expected = crypto.createHash('sha256');
    for (let i = 0; i < size / chunk.length; i++) expected.update(chunk);

    const { proxyServer } = await setup(
      (req, res) => {
        res.writeHead(200, { 'content-length': String(size) });
        let sent = 0;
        const pump = () => {
          while (sent < size) {
            sent += chunk.length;
            if (!res.write(chunk)) return res.once('drain', pump);
          }
          res.end();
        };
        pump();
      },
      { captureLimit: 1024 * 1024 }
    );

    const trafficPromise = proxyServer.nextTraffic();
    const started = Date.now();
    const got = crypto.createHash('sha256');
    let received = 0;
    const { res } = await open(proxyServer.port, '/big');
    await new Promise((resolve) => {
      res.on('data', (c) => {
        got.update(c);
        received += c.length;
      });
      res.on('end', resolve);
    });
    expect(received).toBe(size);
    expect(got.digest('hex')).toBe(expected.digest('hex'));
    // Quadratic re-concatenation of the old implementation took minutes here.
    expect(Date.now() - started).toBeLessThan(8000);

    const traffic = await trafficPromise;
    expect(traffic.response.size).toBe(size);
    expect(traffic.response.body.length).toBe(1024 * 1024);
    expect(traffic.response.truncated).toBe(true);
  }, 20_000);

  it('decodes a compressed stream incrementally and stops at the capture limit', async () => {
    const plain = Buffer.alloc(3 * 1024 * 1024, 'a');
    const gzipped = zlib.gzipSync(plain);
    const { proxyServer } = await setup(
      (req, res) => {
        res.writeHead(200, { 'content-encoding': 'gzip' });
        res.end(gzipped);
      },
      { captureLimit: 64 * 1024 }
    );
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port });
    expect(res.body.equals(gzipped)).toBe(true); // wire untouched
    const traffic = await trafficPromise;
    expect(traffic.response.body.length).toBe(64 * 1024);
    expect(traffic.response.body.subarray(0, 8).toString()).toBe('aaaaaaaa');
    expect(traffic.response.truncated).toBe(true);
    expect(traffic.response.size).toBe(gzipped.length);
    expect(traffic.response.decodeError).toBeUndefined();
  });

  it('reports a fast exchange once and a slow one as pending first', async () => {
    const { proxyServer } = await setup((req, res) => {
      if (req.url === '/slow') setTimeout(() => res.end('slow'), 350);
      else res.end('fast');
    });

    let done = proxyServer.nextTraffic();
    await request({ port: proxyServer.port, path: '/fast' });
    await done;
    expect(proxyServer.events).toHaveLength(1);
    expect(proxyServer.events[0].pending).toBe(false);

    done = proxyServer.nextTraffic();
    await request({ port: proxyServer.port, path: '/slow' });
    await done;
    const slow = proxyServer.events.slice(1);
    expect(slow.length).toBeGreaterThanOrEqual(2);
    expect(slow[0].pending).toBe(true);
    expect(slow.at(-1).pending).toBe(false);
    // Every notify of one exchange carries the same streamId -> one table row.
    expect(new Set(slow.map((e) => e.streamId)).size).toBe(1);
    expect(proxyServer.traffic).toHaveLength(2);
  });

  it('records request and response sizes', async () => {
    const { proxyServer } = await setup((req, res) => {
      req.resume();
      req.on('end', () => res.end('12345'));
    });
    const trafficPromise = proxyServer.nextTraffic();
    await request({ port: proxyServer.port, method: 'POST', body: 'abc' });
    const traffic = await trafficPromise;
    expect(traffic.request.size).toBe(3);
    expect(traffic.response.size).toBe(5);
  });
});

describe('upstream failures', () => {
  it('answers 504 when the upstream sends no response head in time', async () => {
    const { proxyServer } = await setup(() => {}, { settings: { upstreamTimeoutSec: 0.2 } });
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port, path: '/hang' });
    expect(res.statusCode).toBe(504);
    expect(res.headers['x-reversee-error']).toBe('ETIMEDOUT');
    expect(res.body.toString()).toMatch(/no response from the upstream within 0\.2 s/);
    const traffic = await trafficPromise;
    expect(traffic.response.statusCode).toBe(504);
    expect(String(traffic.connectorError)).toMatch(/no response/);
  });

  it('never times out a response whose head has arrived (long-lived streams)', async () => {
    const { proxyServer } = await setup(
      (req, res) => {
        res.writeHead(200);
        res.write('start;');
        setTimeout(() => res.end('end'), 450);
      },
      { settings: { upstreamTimeoutSec: 0.15 } }
    );
    const res = await request({ port: proxyServer.port });
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('start;end');
  });

  it('waits forever when the timeout is disabled', async () => {
    const { proxyServer } = await setup(
      (req, res) => setTimeout(() => res.end('eventually'), 300),
      {
        settings: { upstreamTimeoutSec: 0 },
      }
    );
    const res = await request({ port: proxyServer.port });
    expect(res.body.toString()).toBe('eventually');
  });

  it('explains an unreachable upstream in the 502 body and a header', async () => {
    const upstream = await startUpstream((req, res) => res.end('ok'));
    const settings = makeSettings(upstream.port);
    await closeAll(upstream.server);
    const proxyServer = await startProxyServer(settings);
    openServers.push(proxyServer.server);

    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port, path: '/api/x' });
    expect(res.statusCode).toBe(502);
    expect(res.headers['x-reversee-error']).toBe('ECONNREFUSED');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const text = res.body.toString();
    expect(text).toContain(`http://127.0.0.1:${upstream.port}/api/x`);
    expect(text).toContain('ECONNREFUSED');
    // The view shows what the client actually received.
    const traffic = await trafficPromise;
    expect(traffic.response.body.toString()).toBe(text);
  });

  it('breaks the client response when the upstream dies mid-body', async () => {
    const { proxyServer } = await setup((req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
      setTimeout(() => res.socket.destroy(), 50);
    });
    const trafficPromise = proxyServer.nextTraffic();
    const { res } = await open(proxyServer.port);
    const outcome = await new Promise((resolve) => {
      res.on('data', () => {});
      res.on('end', () => resolve('clean end'));
      res.on('error', () => resolve('error'));
      res.on('close', () => resolve(res.complete ? 'clean end' : 'error'));
    });
    // A truncated body must not look like a complete one.
    expect(outcome).toBe('error');
    const traffic = await trafficPromise;
    expect(traffic.connectorError).toBeTruthy();
    expect(traffic.response.body.toString()).toBe('partial');
  });

  it('stops the upstream request when the client disconnects', async () => {
    let upstreamClosed;
    const closed = new Promise((r) => (upstreamClosed = r));
    const { proxyServer } = await setup((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: tick\n\n');
      const timer = setInterval(() => res.write('data: tick\n\n'), 20);
      res.on('close', () => {
        clearInterval(timer);
        upstreamClosed();
      });
    });
    const trafficPromise = proxyServer.nextTraffic();
    const { req, res } = await open(proxyServer.port, '/stream');
    await nextChunk(res);
    req.destroy();

    await closed; // the upstream connection was torn down, not left running
    const traffic = await trafficPromise;
    expect(traffic.clientAborted).toBe(true);
    expect(traffic.pending).toBeUndefined();
    expect(traffic.response.body.toString()).toContain('data: tick');
  });
});

describe('edited bodies', () => {
  it('corrects a stale request content-length after a breakpoint edit', async () => {
    let seen;
    const upstream = await startUpstream((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen = { body: Buffer.concat(chunks).toString(), length: req.headers['content-length'] };
        res.end('ok');
      });
    });
    const edited = 'a much longer body than the client sent';
    const gate = (req) =>
      Promise.resolve({ headers: { ...req.headers }, body: Buffer.from(edited) });
    const proxyServer = await startProxyServer(makeSettings(upstream.port), { gate });
    openServers.push(upstream.server, proxyServer.server);

    const res = await request({
      port: proxyServer.port,
      method: 'POST',
      headers: { 'content-length': '5' },
      body: 'short',
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual({ body: edited, length: String(edited.length) });
  });

  it('survives an interceptor that sets an illegal response header', async () => {
    const { proxyServer } = await setup((req, res) => res.end('still here'), {
      settings: {
        interceptResponse: true,
        responseInterceptor: "responseParams.headers['x-bad'] = undefined",
      },
    });
    const res = await request({ port: proxyServer.port });
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('still here');
  });
});

describe('interceptor diagnostics on the traffic entry', () => {
  it('records thrown errors and console output per phase', async () => {
    const { proxyServer } = await setup((req, res) => res.end('ok'), {
      settings: {
        interceptRequest: true,
        requestInterceptor: "console.log('path is', requestParams.path); nope.nope = 1",
        interceptResponse: true,
        responseInterceptor: 'console.warn({ status: responseParams.statusCode })',
      },
    });
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port, path: '/diag' });
    expect(res.statusCode).toBe(200); // a broken interceptor never fails the request
    const traffic = await trafficPromise;
    expect(traffic.interceptorErrors).toEqual([
      { phase: 'request', message: expect.stringMatching(/nope is not defined/) },
    ]);
    expect(traffic.interceptorLogs).toEqual(['path is /diag', '[warn] {"status":200}']);
  });

  it('cuts off an interceptor stuck in an infinite loop and still proxies', async () => {
    const { proxyServer } = await setup((req, res) => res.end('made it'), {
      settings: { interceptRequest: true, requestInterceptor: 'while (true) {}' },
    });
    const trafficPromise = proxyServer.nextTraffic();
    const res = await request({ port: proxyServer.port });
    expect(res.body.toString()).toBe('made it');
    const traffic = await trafficPromise;
    expect(traffic.interceptorErrors[0].message).toMatch(/timed out after \d+ ms/);
  });
});
