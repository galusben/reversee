// The gRPC-mode listener (createHttp2ProxyServer) beyond gRPC decoding:
// HTTP/1.1 served on the same port (cleartext sniffing and TLS ALPN), upstream
// session reuse, and a close() that completes with calls still open.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import http2 from 'node:http2';
import { createHttp2ProxyServer } from '../../src/proxy/core/http2';
import { sslOptions, request, startUpstream } from './helpers.mjs';
import { startWsEchoServer } from '../fixtures/ws-echo';

let cleanup = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

const until = async (cond, what = 'condition') => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

/** An h2c upstream answering every stream with a gRPC-shaped response + trailers. */
async function startH2Upstream({ hold = false } = {}) {
  const server = http2.createServer();
  const state = { sessions: 0, streams: 0, cancelled: 0 };
  const live = new Set();
  server.on('session', (session) => {
    state.sessions++;
    live.add(session);
    session.on('close', () => live.delete(session));
  });
  server.on('stream', (stream) => {
    state.streams++;
    stream.on('close', () => {
      if (stream.rstCode !== 0) state.cancelled++;
    });
    stream.respond(
      { ':status': 200, 'content-type': 'application/grpc' },
      { waitForTrailers: true }
    );
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.write('chunk');
    if (!hold) stream.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => server.close(r)));
  return {
    port: server.address().port,
    state,
    killSessions: () => {
      for (const session of live) session.destroy();
    },
  };
}

async function startProxy(upstreamPort, { tls = false, settings = {} } = {}) {
  const entries = new Map();
  const proxy = createHttp2ProxyServer({
    settings: {
      listenProtocol: tls ? 'https' : 'http',
      listenPort: 0,
      destProtocol: 'http',
      dest: '127.0.0.1',
      destPort: upstreamPort,
      enableGrpc: true,
      ...settings,
    },
    sslOptions: tls ? sslOptions : undefined,
    notify: (entry, streamId) => entries.set(streamId ?? entry.trafficId, entry),
  });
  const port = await proxy.listen();
  let closed = false;
  cleanup.push(() => (closed ? undefined : proxy.close()));
  return {
    proxy,
    port,
    entries,
    close: () => {
      closed = true;
      return proxy.close();
    },
  };
}

/** One HTTP/2 call; resolves with status, body and trailers (each trailer event counted). */
function h2Call(origin, { session: shared, options = {} } = {}) {
  return new Promise((resolve, reject) => {
    const session = shared ?? http2.connect(origin, { rejectUnauthorized: false, ...options });
    session.on('error', reject);
    const stream = session.request({
      ':method': 'POST',
      ':path': '/svc/Method',
      'content-type': 'application/grpc',
    });
    const chunks = [];
    let status;
    let trailers;
    let trailerEvents = 0;
    stream.on('response', (h) => (status = h[':status']));
    stream.on('trailers', (t) => {
      trailerEvents++;
      trailers = t;
    });
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('close', () => {
      if (!shared) session.close();
      resolve({ status, body: Buffer.concat(chunks).toString(), trailers, trailerEvents });
    });
    stream.end();
  });
}

describe('gRPC-mode listener over cleartext', () => {
  it('serves HTTP/1.1 and HTTP/2 (prior knowledge) on the same port', async () => {
    const h1Upstream = await startUpstream((req, res) => res.end(`h1 saw ${req.url}`));
    cleanup.push(() => new Promise((r) => h1Upstream.server.close(r)));
    const h2Upstream = await startH2Upstream();
    // Route HTTP/2 calls to the h2 upstream; HTTP/1.1 goes to the default.
    const { port, entries } = await startProxy(h1Upstream.port, {
      settings: {
        routes: [
          {
            id: 'grpc',
            enabled: true,
            pathPattern: '^/svc/',
            destProtocol: 'http',
            dest: '127.0.0.1',
            destPort: h2Upstream.port,
          },
        ],
      },
    });

    const h1 = await request({ port, path: '/plain' });
    expect(h1.statusCode).toBe(200);
    expect(h1.body.toString()).toBe('h1 saw /plain');

    const h2 = await h2Call(`http://127.0.0.1:${port}`);
    expect(h2.status).toBe(200);
    expect(h2.body).toBe('chunk');
    expect(String(h2.trailers['grpc-status'])).toBe('0');

    await until(() => [...entries.values()].filter((e) => !e.pending).length === 2, 'both entries');
    const urls = [...entries.values()].map((e) => e.request.url).sort();
    expect(urls).toEqual(['/plain', '/svc/Method']);
    const grpcEntry = [...entries.values()].find((e) => e.grpc);
    expect(grpcEntry.request.target.port).toBe(h2Upstream.port);
  });

  it('applies interceptors to the HTTP/1.1 clients of a gRPC-mode listener', async () => {
    const upstream = await startUpstream((req, res) => res.end('original'));
    cleanup.push(() => new Promise((r) => upstream.server.close(r)));
    const { port } = await startProxy(upstream.port, {
      settings: { interceptResponse: true, responseInterceptor: "responseParams.body = 'edited'" },
    });
    expect((await request({ port })).body.toString()).toBe('edited');
  });

  it('tunnels WebSockets on a gRPC-mode listener', async () => {
    const echo = await startWsEchoServer();
    cleanup.push(() => echo.close());
    const { port } = await startProxy(echo.port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];
    ws.addEventListener('message', (e) => messages.push(e.data));
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('open failed')));
    });
    ws.send('through grpc mode');
    await until(() => messages.length === 2, 'echo');
    expect(messages).toEqual(['welcome', 'echo: through grpc mode']);
    ws.close();
  });
});

describe('gRPC-mode listener over TLS', () => {
  it('negotiates h2 or http/1.1 by ALPN and sends trailers exactly once', async () => {
    const h2Upstream = await startH2Upstream();
    const { port } = await startProxy(h2Upstream.port, { tls: true });

    const h2 = await h2Call(`https://127.0.0.1:${port}`);
    expect(h2.status).toBe(200);
    expect(h2.body).toBe('chunk');
    // With Node's HTTP/2 compatibility layer attached, trailers went out twice.
    expect(h2.trailerEvents).toBe(1);
    expect(String(h2.trailers['grpc-status'])).toBe('0');
  });

  it('serves an HTTP/1.1 client on the TLS listener', async () => {
    const upstream = await startUpstream((req, res) => res.end(`tls h1 ${req.httpVersion}`));
    cleanup.push(() => new Promise((r) => upstream.server.close(r)));
    const { port, entries } = await startProxy(upstream.port, { tls: true });
    const res = await request({ tls: true, port, path: '/over-tls' });
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toBe('tls h1 1.1');
    await until(() => [...entries.values()].some((e) => !e.pending), 'entry');
    expect([...entries.values()][0].request.url).toBe('/over-tls');
  });
});

describe('upstream HTTP/2 sessions', () => {
  it('reuses one upstream session for many calls instead of opening one per call', async () => {
    const upstream = await startH2Upstream();
    const { port } = await startProxy(upstream.port);
    const session = http2.connect(`http://127.0.0.1:${port}`);
    for (let i = 0; i < 5; i++) {
      const res = await h2Call(null, { session });
      expect(res.status).toBe(200);
    }
    await Promise.all([1, 2, 3].map(() => h2Call(null, { session })));
    session.close();
    expect(upstream.state.streams).toBe(8);
    expect(upstream.state.sessions).toBe(1);
  });

  it('reconnects after the upstream session goes away', async () => {
    const upstream = await startH2Upstream();
    const { port } = await startProxy(upstream.port);
    expect((await h2Call(`http://127.0.0.1:${port}`)).status).toBe(200);
    // The upstream drops its connection; the next call must open a fresh one.
    upstream.killSessions();
    await until(() => upstream.state.sessions === 1, 'session closed');
    await new Promise((r) => setTimeout(r, 50));
    expect((await h2Call(`http://127.0.0.1:${port}`)).status).toBe(200);
    expect(upstream.state.sessions).toBe(2);
  });

  it('marks the entry failed and closes the client stream when the upstream is down', async () => {
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port;
    await new Promise((r) => dead.close(r));

    const { port, entries } = await startProxy(deadPort);
    const outcome = await h2Call(`http://127.0.0.1:${port}`).catch((e) => e);
    // Either an RST (rejection) or a close without a status — never a 200.
    expect(outcome?.status).not.toBe(200);
    await until(() => [...entries.values()].some((e) => !e.pending), 'final entry');
    const entry = [...entries.values()][0];
    expect(entry.connectorError).toBeTruthy();
    expect(entry.pending).toBeUndefined();
  });

  it('cancels the upstream call when the client cancels', async () => {
    const upstream = await startH2Upstream({ hold: true });
    const { port, entries } = await startProxy(upstream.port);
    const session = http2.connect(`http://127.0.0.1:${port}`);
    const stream = session.request({ ':method': 'POST', ':path': '/svc/Method' });
    stream.on('error', () => {});
    await new Promise((r) => stream.once('data', r));
    stream.close(http2.constants.NGHTTP2_CANCEL);
    await until(() => upstream.state.cancelled === 1, 'upstream cancel');
    await until(() => [...entries.values()].every((e) => !e.pending), 'entry finalized');
    session.close();
  });
});

describe('stopping a gRPC-mode listener', () => {
  it('close() completes while a streaming call is still open', async () => {
    const upstream = await startH2Upstream({ hold: true });
    const { port, close } = await startProxy(upstream.port);
    const session = http2.connect(`http://127.0.0.1:${port}`);
    session.on('error', () => {});
    const stream = session.request({ ':method': 'POST', ':path': '/svc/Method' });
    stream.on('error', () => {});
    await new Promise((r) => stream.once('data', r)); // the call is live

    // Previously server.close() waited on the open stream forever.
    await expect(
      Promise.race([
        close(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 3000)),
      ])
    ).resolves.toBeUndefined();
    session.destroy();
  });
});
