// WebSocket support: the frame parser / message assembler on hand-built
// frames, and the tunnel end to end — Node's built-in WebSocket client talking
// through the real proxy server to a hand-rolled echo server.
import { describe, it, expect, afterEach } from 'vitest';
import zlib from 'node:zlib';
import http from 'node:http';
import net from 'node:net';
import { startProxyServer, closeAll, makeSettings, request } from './helpers.mjs';
import { startWsEchoServer, encodeFrame } from '../fixtures/ws-echo';
import {
  WsFrameParser,
  WsMessageAssembler,
  WS_PAYLOAD_LIMIT,
} from '../../src/proxy/core/ws-frames';
import { WS_MESSAGE_LIMIT } from '../../src/proxy/core/websocket';

let cleanup = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

const until = async (cond, what = 'condition') => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

function assemble(buffers, options) {
  const out = [];
  const assembler = new WsMessageAssembler((m) => out.push(m), options);
  for (const b of buffers) assembler.push(b);
  return { out, assembler };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('WsFrameParser', () => {
  it('parses masked and unmasked frames of every length encoding', () => {
    const parser = new WsFrameParser();
    const small = Buffer.from('hi');
    const medium = Buffer.alloc(300, 'm');
    const large = Buffer.alloc(70_000, 'L');
    const frames = parser.push(
      Buffer.concat([
        encodeFrame(0x1, small, { mask: true }),
        encodeFrame(0x2, medium),
        encodeFrame(0x1, large, { mask: true }),
      ])
    );
    expect(frames.map((f) => [f.opcode, f.size, f.fin])).toEqual([
      [1, 2, true],
      [2, 300, true],
      [1, 70_000, true],
    ]);
    expect(frames[0].payload.toString()).toBe('hi'); // unmasked
    expect(frames[1].payload.equals(medium)).toBe(true);
    // Kept only up to the capture limit, but the full size is reported.
    expect(frames[2].payload.length).toBe(WS_PAYLOAD_LIMIT);
    expect(frames[2].payload.every((b) => b === 0x4c)).toBe(true);
  });

  it('reassembles frames split at arbitrary byte boundaries', () => {
    const wire = Buffer.concat([
      encodeFrame(0x1, Buffer.from('first message'), { mask: true }),
      encodeFrame(0x1, Buffer.alloc(200, 'x'), { mask: true }),
    ]);
    const parser = new WsFrameParser();
    const frames = [];
    for (let i = 0; i < wire.length; i++) frames.push(...parser.push(wire.subarray(i, i + 1)));
    expect(frames).toHaveLength(2);
    expect(frames[0].payload.toString()).toBe('first message');
    expect(frames[1].payload.toString()).toBe('x'.repeat(200));
  });

  it('does not mutate the bytes it is given', () => {
    const frame = encodeFrame(0x1, Buffer.from('untouched'), { mask: true });
    const copy = Buffer.from(frame);
    new WsFrameParser().push(frame);
    expect(frame.equals(copy)).toBe(true);
  });
});

describe('WsMessageAssembler', () => {
  it('joins fragments and lets control frames interleave', async () => {
    const { out } = assemble([
      encodeFrame(0x1, Buffer.from('Hel'), { fin: false }),
      encodeFrame(0x9, Buffer.from('p')), // ping in the middle of a message
      encodeFrame(0x0, Buffer.from('lo'), { fin: true }),
    ]);
    await settle();
    expect(out).toEqual([
      { opcode: 'ping', size: 1 },
      { opcode: 'text', size: 5, text: 'Hello' },
    ]);
  });

  it('summarizes binary messages by size and decodes close frames', async () => {
    const close = Buffer.concat([Buffer.from([0x03, 0xe9]), Buffer.from('going away')]);
    const { out } = assemble([
      encodeFrame(0x2, Buffer.from([1, 2, 3, 4])),
      encodeFrame(0x8, close),
    ]);
    await settle();
    expect(out).toEqual([
      { opcode: 'binary', size: 4 },
      { opcode: 'close', size: 12, closeCode: 1001, text: 'going away' },
    ]);
  });

  it('inflates permessage-deflate messages, sharing the window across messages', async () => {
    // One deflate context for all messages (context takeover): later messages
    // back-reference earlier ones, so they only decode with a persistent inflater.
    const deflater = zlib.createDeflateRaw();
    const compress = (text) =>
      new Promise((resolve) => {
        const chunks = [];
        const onData = (c) => chunks.push(c);
        deflater.on('data', onData);
        deflater.write(text);
        deflater.flush(zlib.constants.Z_SYNC_FLUSH, () => {
          deflater.removeListener('data', onData);
          const all = Buffer.concat(chunks);
          resolve(all.subarray(0, all.length - 4));
        });
      });
    const texts = ['{"type":"tick","value":1}', '{"type":"tick","value":2}', 'plain'];
    const frames = [];
    for (const t of texts.slice(0, 2)) {
      frames.push(encodeFrame(0x1, await compress(t), { rsv1: true }));
    }
    frames.push(encodeFrame(0x1, Buffer.from(texts[2]))); // uncompressed messages are allowed too
    const { out, assembler } = assemble(frames, { deflate: true });
    // Announced at once, in order; the text arrives when inflation completes.
    expect(out).toHaveLength(3);
    await assembler.idle();
    expect(out.map((m) => m.text)).toEqual(texts);
  });

  it('reports a truncated message instead of garbage when a compressed payload exceeds the cap', async () => {
    const big = zlib.deflateRawSync(Buffer.from(Array.from({ length: 4000 }, (_, i) => i).join()), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
    const { out } = assemble([encodeFrame(0x1, big.subarray(0, big.length - 4), { rsv1: true })], {
      deflate: true,
      payloadLimit: 64,
    });
    await settle();
    expect(out).toEqual([{ opcode: 'text', size: big.length - 4, truncated: true }]);
  });
});

describe('WebSocket tunnel', () => {
  async function setup({ serverOptions, settings = {} } = {}) {
    const echo = await startWsEchoServer(serverOptions);
    const proxyServer = await startProxyServer(makeSettings(echo.port, settings));
    cleanup.push(
      () => echo.close(),
      () => closeAll(proxyServer.server)
    );
    return { echo, proxyServer };
  }

  function connect(port, path = '/socket') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const messages = [];
    ws.addEventListener('message', (e) => messages.push(e.data));
    const opened = new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('websocket failed to open')));
    });
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve));
    return { ws, messages, opened, closed };
  }

  it('tunnels messages both ways and records them on one traffic entry', async () => {
    const { echo, proxyServer } = await setup({ settings: { hostRewrite: true } });
    const { ws, messages, opened, closed } = connect(proxyServer.port);
    await opened;
    await until(() => messages.length === 1, 'welcome');
    ws.send('ping one');
    ws.send('ping two');
    await until(() => messages.length === 3, 'echoes');
    expect(messages).toEqual(['welcome', 'echo: ping one', 'echo: ping two']);
    expect(echo.received).toEqual(['ping one', 'ping two']);
    // The handshake was forwarded like any request (Host rewritten to the upstream).
    expect(echo.handshakes[0].host).toBe(`127.0.0.1:${echo.port}`);

    // While open the entry is pending.
    await until(() => proxyServer.traffic.length === 1, 'entry');
    expect(proxyServer.traffic[0].pending).toBe(true);
    expect(proxyServer.traffic[0].response.statusCode).toBe(101);

    const done = proxyServer.nextTraffic();
    ws.close(1000, 'done');
    await closed;
    const entry = await done;
    expect(proxyServer.traffic).toHaveLength(1); // every update hit the same entry
    expect(entry.pending).toBeUndefined();
    expect(entry.request.url).toBe('/socket');
    expect(entry.ws.closed).toBe(true);
    const summary = entry.ws.messages.map((m) => `${m.from}:${m.opcode}:${m.text ?? ''}`);
    expect(summary.slice(0, 5)).toEqual([
      'server:text:welcome',
      'client:text:ping one',
      'client:text:ping two',
      'server:text:echo: ping one',
      'server:text:echo: ping two',
    ]);
    expect(summary).toContain('client:close:done');
    expect(entry.ws.messages.find((m) => m.opcode === 'close').closeCode).toBe(1000);
    expect(entry.ws.messageCount).toBe(entry.ws.messages.length);
  });

  it('decodes permessage-deflate traffic for the view without touching the wire', async () => {
    const { echo, proxyServer } = await setup({ serverOptions: { deflate: true } });
    const { ws, messages, opened } = connect(proxyServer.port);
    await opened;
    expect(ws.extensions).toContain('permessage-deflate'); // negotiated end to end
    const text = 'compress me '.repeat(40);
    ws.send(text);
    await until(() => messages.length === 2, 'echo');
    expect(messages[1]).toBe(`echo: ${text}`);
    expect(echo.received).toEqual([text]);

    const done = proxyServer.nextTraffic();
    ws.close();
    const entry = await done;
    const texts = entry.ws.messages.filter((m) => m.opcode === 'text').map((m) => m.text);
    expect(texts).toEqual(['welcome', text, `echo: ${text}`]);
    // Size is what crossed the wire: the server compressed its echo, so it is
    // smaller than the text it carries. (Node's client sends uncompressed.)
    const echoed = entry.ws.messages.find((m) => m.text === `echo: ${text}`);
    expect(echoed.from).toBe('server');
    expect(echoed.size).toBeLessThan(text.length);
  });

  it('records the close initiated by the server', async () => {
    const { proxyServer } = await setup();
    const { ws, opened, closed } = connect(proxyServer.port);
    await opened;
    const done = proxyServer.nextTraffic();
    ws.send('bye');
    const event = await closed;
    expect(event.code).toBe(1000);
    const entry = await done;
    const close = entry.ws.messages.find((m) => m.from === 'server' && m.opcode === 'close');
    expect(close).toMatchObject({ closeCode: 1000, text: 'server done' });
  });

  it('keeps only the most recent messages of a chatty connection', async () => {
    const { proxyServer } = await setup();
    const { ws, messages, opened } = connect(proxyServer.port);
    await opened;
    const total = WS_MESSAGE_LIMIT; // + welcome + echoes -> well over the cap
    for (let i = 0; i < total; i++) ws.send(`m${i}`);
    await until(() => messages.length === total + 1, 'all echoes');
    const done = proxyServer.nextTraffic();
    ws.close();
    const entry = await done;
    expect(entry.ws.messages.length).toBe(WS_MESSAGE_LIMIT);
    expect(entry.ws.messageCount).toBeGreaterThan(2 * total);
  });

  it('relays the upstream refusal when it will not upgrade', async () => {
    const { proxyServer } = await setup({ serverOptions: { rejectWith: 403 } });
    const { opened } = connect(proxyServer.port);
    const done = proxyServer.nextTraffic();
    await expect(opened).rejects.toThrow();
    const entry = await done;
    expect(entry.response.statusCode).toBe(403);
    expect(entry.response.body.toString()).toBe('denied');
    expect(entry.ws).toBeUndefined();
  });

  // An upstream that declines every upgrade, writing what `write` produces on
  // the raw socket. `sent` counts the bytes the upstream managed to hand to its
  // socket, so a stall there shows the proxy's backpressure reaching it.
  async function startDecliningUpstream(write) {
    const state = { sent: 0, closed: false };
    const server = http.createServer();
    server.on('upgrade', (_req, socket) => {
      socket.on('error', () => {});
      socket.on('close', () => (state.closed = true));
      void write(socket, state);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => closeAll(server));
    return { port: server.address().port, state };
  }

  // Writes and waits for drain; false once the socket is gone.
  const writeOut = async (socket, state, data) => {
    if (socket.destroyed) return false;
    const ok = socket.write(data);
    state.sent += data.length;
    if (!ok) {
      await new Promise((r) => {
        const done = () => {
          socket.off('drain', done);
          socket.off('close', done);
          r();
        };
        socket.on('drain', done);
        socket.on('close', done);
      });
    }
    return !socket.destroyed;
  };

  // A raw upgrade request whose reading the test controls.
  function rawUpgrade(port) {
    const socket = net.connect(port, '127.0.0.1');
    socket.write(
      'GET /socket HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
    );
    return socket;
  }

  const CHUNK = 64 * 1024;
  const pattern = (i) => Buffer.alloc(CHUNK, i % 251);

  it('relays a large declined-upgrade body with backpressure to a slow client', async () => {
    const CHUNKS = 256; // 16 MB
    const total = CHUNKS * CHUNK;
    const upstream = await startDecliningUpstream(async (socket, state) => {
      await writeOut(
        socket,
        state,
        `HTTP/1.1 401 Unauthorized\r\ncontent-length: ${total}\r\n\r\n`
      );
      for (let i = 0; i < CHUNKS; i++) if (!(await writeOut(socket, state, pattern(i)))) return;
      socket.end();
    });
    const captureLimit = 256 * 1024;
    const proxyServer = await startProxyServer(makeSettings(upstream.port), { captureLimit });
    cleanup.push(() => closeAll(proxyServer.server));
    const done = proxyServer.nextTraffic();

    const client = rawUpgrade(proxyServer.port);
    client.pause(); // a client that is not reading
    await new Promise((r) => setTimeout(r, 400));
    // The upstream is held back: only socket buffers' worth of the body left it.
    expect(upstream.state.sent).toBeLessThan(total / 2);

    const received = [];
    client.on('data', (c) => received.push(c));
    const ended = new Promise((r) => client.on('end', r));
    client.resume();
    await ended;
    const raw = Buffer.concat(received);
    const split = raw.indexOf('\r\n\r\n');
    expect(raw.subarray(0, split).toString()).toMatch(/^HTTP\/1\.1 401 /);
    const body = raw.subarray(split + 4);
    expect(body.length).toBe(total);
    for (let i = 0; i < CHUNKS; i++) {
      expect(body.subarray(i * CHUNK, (i + 1) * CHUNK).equals(pattern(i))).toBe(true);
    }

    const entry = await done;
    expect(entry.pending).toBeUndefined();
    expect(entry.response.statusCode).toBe(401);
    expect(entry.response.size).toBe(total);
    expect(entry.response.body.length).toBe(captureLimit); // bounded capture
    expect(entry.response.truncated).toBe(true);
    expect(entry.ws).toBeUndefined();
    expect(entry.clientAborted).toBeUndefined();
  });

  it('stops the upstream when the client leaves a declined upgrade mid-body', async () => {
    // An endless body: only the client going away can stop it.
    const upstream = await startDecliningUpstream(async (socket, state) => {
      await writeOut(socket, state, 'HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\n\r\n');
      for (let i = 0; ; i++) if (!(await writeOut(socket, state, pattern(i)))) return;
    });
    const proxyServer = await startProxyServer(makeSettings(upstream.port));
    cleanup.push(() => closeAll(proxyServer.server));
    const done = proxyServer.nextTraffic();

    const client = rawUpgrade(proxyServer.port);
    let got = 0;
    await new Promise((resolve) =>
      client.on('data', (c) => {
        got += c.length;
        if (got > 4 * CHUNK) resolve();
      })
    );
    client.destroy();

    const entry = await done;
    expect(entry.pending).toBeUndefined();
    expect(entry.clientAborted).toBe(true);
    expect(entry.response.statusCode).toBe(404);
    expect(entry.response.body.length).toBeGreaterThan(0);
    await until(() => upstream.state.closed, 'upstream connection closed');
  });

  it('closes the client when the upstream dies mid-body of a declined upgrade', async () => {
    const upstream = await startDecliningUpstream(async (socket, state) => {
      await writeOut(socket, state, 'HTTP/1.1 403 Forbidden\r\ncontent-length: 100000\r\n\r\n');
      await writeOut(socket, state, Buffer.alloc(1000, 'x'));
      setTimeout(() => socket.destroy(), 50);
    });
    const proxyServer = await startProxyServer(makeSettings(upstream.port));
    cleanup.push(() => closeAll(proxyServer.server));
    const done = proxyServer.nextTraffic();

    const client = rawUpgrade(proxyServer.port);
    const received = [];
    client.on('data', (c) => received.push(c));
    client.on('error', () => {});
    const clientClosed = new Promise((r) => client.on('close', r));

    const entry = await done;
    await clientClosed; // not left hanging on a body that will never arrive
    expect(Buffer.concat(received).toString()).toMatch(/^HTTP\/1\.1 403 /);
    expect(entry.pending).toBeUndefined();
    expect(entry.response.statusCode).toBe(403);
    expect(entry.connectorError).toBeTruthy();
    expect(entry.response.body.toString()).toBe('x'.repeat(1000));
  });

  it('answers 502 when the upstream is down', async () => {
    const echo = await startWsEchoServer();
    const settings = makeSettings(echo.port);
    await echo.close();
    const proxyServer = await startProxyServer(settings);
    cleanup.push(() => closeAll(proxyServer.server));
    const { opened } = connect(proxyServer.port);
    const done = proxyServer.nextTraffic();
    await expect(opened).rejects.toThrow();
    const entry = await done;
    expect(entry.response.statusCode).toBe(502);
    expect(entry.connectorError).toBeTruthy();
  });

  it('closes open tunnels when the proxy stops', async () => {
    const { proxyServer } = await setup();
    const { opened, closed } = connect(proxyServer.port);
    await opened;
    const stop = proxyServer.server.close();
    await closed; // the client is disconnected...
    await stop; // ...and close() resolves instead of waiting on the tunnel
  });

  it('still serves ordinary requests on the same listener', async () => {
    const { proxyServer } = await setup();
    const res = await request({ port: proxyServer.port, path: '/plain' });
    expect(res.statusCode).toBe(426);
    expect(res.body.toString()).toBe('upgrade required');
  });
});
