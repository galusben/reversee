// Integration test: a real gRPC round-trip through createHttp2ProxyServer.
// A hand-rolled HTTP/2 (h2c) upstream speaks gRPC framing + trailers; the proxy
// forwards it and decodes messages against injected proto types. Covers unary,
// server-streaming, and a non-OK grpc-status, asserting decoded JSON both ways,
// the captured grpc-status trailer, and byte-exact raw passthrough; plus the
// per-direction message cap on long streams and the raw-capture byte cap.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http2 from 'node:http2';
import protobuf from 'protobufjs';
import { createHttp2ProxyServer, GRPC_MESSAGE_LIMIT } from '../../src/proxy/core/http2';
import { encodeGrpcFrame, parseGrpcFrames } from '../../src/proxy/core/grpc-frames';

const PROTO = `
  syntax = "proto3";
  package test;
  message EchoRequest { string text = 1; }
  message EchoReply { string text = 1; }
  service Echo {
    rpc Unary (EchoRequest) returns (EchoReply);
    rpc ServerStream (EchoRequest) returns (stream EchoReply);
    rpc Boom (EchoRequest) returns (EchoReply);
  }
`;

const root = protobuf.parse(PROTO).root;
root.resolveAll();
const EchoRequest = root.lookupType('test.EchoRequest');
const EchoReply = root.lookupType('test.EchoReply');

/** Messages the ManyStream method sends: well past the proxy's per-direction cap. */
const MANY = GRPC_MESSAGE_LIMIT + 150;

const reqFrame = (text) => encodeGrpcFrame(Buffer.from(EchoRequest.encode({ text }).finish()));
const replyFrame = (text) => encodeGrpcFrame(Buffer.from(EchoReply.encode({ text }).finish()));

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  );
}

// A minimal gRPC server over h2c that reads the request message and replies
// per method, finishing with a grpc-status trailer.
function startGrpcUpstream() {
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const path = headers[':path'];
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const frames = parseGrpcFrames(Buffer.concat(chunks)).frames;
      const [frame] = frames;
      const name = EchoRequest.decode(frame.data).text;

      if (path === '/test.Echo/Boom') {
        // Trailers-Only: status rides in the response HEADERS, END_STREAM.
        stream.respond(
          {
            ':status': '200',
            'content-type': 'application/grpc',
            'grpc-status': '5',
            'grpc-message': 'not found',
          },
          { endStream: true }
        );
        return;
      }

      stream.respond(
        { ':status': '200', 'content-type': 'application/grpc+proto' },
        { waitForTrailers: true }
      );
      stream.on('wantTrailers', () =>
        stream.sendTrailers({ 'grpc-status': '0', 'grpc-message': 'OK' })
      );

      if (path === '/test.Echo/ServerStream') {
        for (let i = 1; i <= 3; i++) stream.write(replyFrame(`${name} #${i}`));
      } else if (path === '/test.Echo/ManyStream') {
        // More messages than the proxy keeps, each in its own DATA frame on its own tick.
        let i = 0;
        const next = () => {
          if (++i > MANY) return stream.end();
          stream.write(replyFrame(`${name} #${i}`));
          setImmediate(next);
        };
        next();
        return;
      } else if (path === '/test.Echo/ClientStream') {
        stream.write(replyFrame(`got ${frames.length}`));
      } else {
        stream.write(replyFrame(`hello ${name}`));
      }
      stream.end();
    });
  });
  return listen(server).then((port) => ({ server, port }));
}

// Drives one gRPC call as an h2c client; resolves with response frames + trailers.
// `text` may be an array to send several request messages (client streaming).
function grpcCall(port, path, text) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`http://127.0.0.1:${port}`);
    session.on('error', reject);
    const stream = session.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc+proto',
      te: 'trailers',
    });
    const chunks = [];
    let trailers = {};
    let status;
    stream.on('response', (h) => {
      status = Number(h[':status']);
      if (h['grpc-status'] !== undefined) trailers = h; // Trailers-Only
    });
    stream.on('trailers', (t) => {
      trailers = t;
    });
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      session.close();
      const messages = parseGrpcFrames(Buffer.concat(chunks)).frames.map(
        (f) => EchoReply.decode(f.data).text
      );
      resolve({ status, messages, trailers, raw: Buffer.concat(chunks) });
    });
    stream.on('error', reject);
    const texts = Array.isArray(text) ? text : [text];
    stream.end(Buffer.concat(texts.map(reqFrame)));
  });
}

const resolveMethod = (path) =>
  path.startsWith('/test.Echo/')
    ? { specId: 's1', requestType: EchoRequest, responseType: EchoReply }
    : undefined;

let upstream;
let proxy;
let proxyPort;
const entries = new Map(); // trafficId -> latest entry (the store upserts the same way)
const notifyCounts = new Map(); // trafficId -> how many times it was reported

beforeAll(async () => {
  upstream = await startGrpcUpstream();
  proxy = createHttp2ProxyServer({
    settings: {
      listenProtocol: 'http',
      listenPort: 0,
      destProtocol: 'http',
      dest: '127.0.0.1',
      destPort: upstream.port,
      allowSelfSignedUpstream: true,
      enableGrpc: true,
    },
    notify: (entry) => {
      entries.set(entry.trafficId, entry);
      notifyCounts.set(entry.trafficId, (notifyCounts.get(entry.trafficId) ?? 0) + 1);
    },
    resolveMethod,
  });
  proxyPort = await proxy.listen();
});

afterAll(async () => {
  await proxy.close();
  upstream.server.close();
});

function latestFor(path) {
  return [...entries.values()].filter((e) => e.grpc?.method === path).at(-1);
}

describe('gRPC over the HTTP/2 proxy', () => {
  it('proxies and decodes a unary call', async () => {
    const res = await grpcCall(proxyPort, '/test.Echo/Unary', 'ada');
    expect(res.status).toBe(200);
    expect(res.messages).toEqual(['hello ada']);
    expect(String(res.trailers['grpc-status'])).toBe('0');

    const entry = latestFor('/test.Echo/Unary');
    expect(entry.grpc.requestMessages.map((m) => m.json.text)).toEqual(['ada']);
    expect(entry.grpc.responseMessages.map((m) => m.json.text)).toEqual(['hello ada']);
    expect(entry.grpc.status).toBe(0);
    expect(entry.grpc.matchedSpecId).toBe('s1');
  });

  it('decodes every message of a server-streaming call', async () => {
    const res = await grpcCall(proxyPort, '/test.Echo/ServerStream', 'bob');
    expect(res.messages).toEqual(['bob #1', 'bob #2', 'bob #3']);

    const entry = latestFor('/test.Echo/ServerStream');
    expect(entry.grpc.responseMessages.map((m) => m.json.text)).toEqual([
      'bob #1',
      'bob #2',
      'bob #3',
    ]);
    expect(entry.grpc.status).toBe(0);
    // Raw response bytes pass through byte-for-byte.
    const reframed = Buffer.concat([
      replyFrame('bob #1'),
      replyFrame('bob #2'),
      replyFrame('bob #3'),
    ]);
    expect(Buffer.compare(res.raw, reframed)).toBe(0);
  });

  it('counts every message of a unary call', async () => {
    await grpcCall(proxyPort, '/test.Echo/Unary', 'cy');
    const entry = latestFor('/test.Echo/Unary');
    expect(entry.grpc.requestMessageCount).toBe(1);
    expect(entry.grpc.responseMessageCount).toBe(1);
  });

  it('keeps only the most recent messages of a long stream, with the totals', async () => {
    const res = await grpcCall(proxyPort, '/test.Echo/ManyStream', 'eve');
    // The client gets every message: the cap only bounds what is kept for display.
    expect(res.messages).toHaveLength(MANY);
    expect(res.messages.at(-1)).toBe(`eve #${MANY}`);

    const entry = latestFor('/test.Echo/ManyStream');
    expect(entry.pending).toBeUndefined();
    expect(entry.grpc.responseMessageCount).toBe(MANY);
    expect(entry.grpc.responseMessages).toHaveLength(GRPC_MESSAGE_LIMIT);
    // The oldest are dropped, in order, and the final message is present.
    expect(entry.grpc.responseMessages[0].json.text).toBe(`eve #${MANY - GRPC_MESSAGE_LIMIT + 1}`);
    expect(entry.grpc.responseMessages.at(-1).json.text).toBe(`eve #${MANY}`);
    expect(entry.grpc.requestMessageCount).toBe(1);
    expect(entry.grpc.requestMessages).toHaveLength(1);
    // First sight + a few throttled progress updates + the final one — not one per frame.
    expect(notifyCounts.get(entry.trafficId)).toBeLessThan(20);
  });

  it('caps the request direction of a client-streaming call the same way', async () => {
    const texts = Array.from({ length: MANY }, (_, i) => `m${i + 1}`);
    const res = await grpcCall(proxyPort, '/test.Echo/ClientStream', texts);
    expect(res.messages).toEqual([`got ${MANY}`]); // the upstream received them all

    const entry = latestFor('/test.Echo/ClientStream');
    expect(entry.grpc.requestMessageCount).toBe(MANY);
    expect(entry.grpc.requestMessages).toHaveLength(GRPC_MESSAGE_LIMIT);
    expect(entry.grpc.requestMessages.at(-1).json.text).toBe(`m${MANY}`);
    expect(entry.grpc.responseMessageCount).toBe(1);
  });

  it('captures a non-OK grpc-status (Trailers-Only)', async () => {
    const res = await grpcCall(proxyPort, '/test.Echo/Boom', 'x');
    expect(String(res.trailers['grpc-status'])).toBe('5');

    const entry = latestFor('/test.Echo/Boom');
    expect(entry.grpc.status).toBe(5);
    expect(entry.grpc.statusMessage).toBe('not found');
  });
});

describe('raw capture of an HTTP/2 call', () => {
  const LIMIT = 100;
  let small;
  let smallPort;
  const captured = new Map();

  beforeAll(async () => {
    small = createHttp2ProxyServer({
      settings: {
        listenProtocol: 'http',
        listenPort: 0,
        destProtocol: 'http',
        dest: '127.0.0.1',
        destPort: upstream.port,
        allowSelfSignedUpstream: true,
        enableGrpc: true,
      },
      captureLimit: LIMIT,
      notify: (entry) => captured.set(entry.trafficId, entry),
      resolveMethod,
    });
    smallPort = await small.listen();
  });

  afterAll(() => small.close());

  const latest = () => [...captured.values()].at(-1);

  it('keeps the part of the chunk that crosses the cap, reaching exactly the cap', async () => {
    const text = 'x'.repeat(3 * LIMIT);
    const res = await grpcCall(smallPort, '/test.Echo/Unary', text);
    expect(res.messages).toEqual([`hello ${text}`]); // the wire is untouched

    const entry = latest();
    const sentReq = reqFrame(text);
    // One DATA chunk crosses the cap: its leading bytes are kept, not dropped.
    expect(entry.request.body.length).toBe(LIMIT);
    expect(Buffer.compare(entry.request.body, sentReq.subarray(0, LIMIT))).toBe(0);
    expect(entry.request.size).toBe(sentReq.length);
    expect(entry.request.truncated).toBe(true);

    expect(entry.response.body.length).toBe(LIMIT);
    expect(Buffer.compare(entry.response.body, res.raw.subarray(0, LIMIT))).toBe(0);
    expect(entry.response.size).toBe(res.raw.length);
    expect(entry.response.truncated).toBe(true);
    // Messages are decoded from the full stream, not the capped capture.
    expect(entry.grpc.responseMessages[0].json.text).toBe(`hello ${text}`);
  });

  it('keeps a body at or under the cap whole and not truncated', async () => {
    // A frame of exactly LIMIT bytes: 5-byte header + 2-byte field tag/length + text.
    const text = 'y'.repeat(LIMIT - 7);
    expect(reqFrame(text).length).toBe(LIMIT);
    await grpcCall(smallPort, '/test.Echo/Unary', text);

    const entry = latest();
    expect(entry.request.body.length).toBe(LIMIT);
    expect(entry.request.size).toBe(LIMIT);
    expect(entry.request.truncated).toBeUndefined();
    expect(entry.response.truncated).toBe(true); // "hello " pushes the reply past it
  });
});
