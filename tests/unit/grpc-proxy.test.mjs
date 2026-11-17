// Integration test: a real gRPC round-trip through createHttp2ProxyServer.
// A hand-rolled HTTP/2 (h2c) upstream speaks gRPC framing + trailers; the proxy
// forwards it and decodes messages against injected proto types. Covers unary,
// server-streaming, and a non-OK grpc-status, asserting decoded JSON both ways,
// the captured grpc-status trailer, and byte-exact raw passthrough.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http2 from 'node:http2';
import protobuf from 'protobufjs';
import { createHttp2ProxyServer } from '../../src/proxy/core/http2';
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
      const [frame] = parseGrpcFrames(Buffer.concat(chunks)).frames;
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
        // Many messages, each in its own DATA frame on its own tick.
        let i = 0;
        const next = () => {
          if (++i > 300) return stream.end();
          stream.write(replyFrame(`${name} #${i}`));
          setImmediate(next);
        };
        next();
        return;
      } else {
        stream.write(replyFrame(`hello ${name}`));
      }
      stream.end();
    });
  });
  return listen(server).then((port) => ({ server, port }));
}

// Drives one gRPC call as an h2c client; resolves with response frames + trailers.
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
    stream.end(reqFrame(text));
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

  it('coalesces the updates of a busy streaming call instead of reporting every frame', async () => {
    const res = await grpcCall(proxyPort, '/test.Echo/ManyStream', 'eve');
    expect(res.messages).toHaveLength(300);

    const entry = latestFor('/test.Echo/ManyStream');
    expect(entry.pending).toBeUndefined();
    expect(entry.grpc.responseMessages).toHaveLength(300);
    expect(entry.grpc.responseMessages.at(-1).json.text).toBe('eve #300');
    // First sight + a few throttled progress updates + the final one — not 300+.
    expect(notifyCounts.get(entry.trafficId)).toBeLessThan(20);
  });

  it('captures a non-OK grpc-status (Trailers-Only)', async () => {
    const res = await grpcCall(proxyPort, '/test.Echo/Boom', 'x');
    expect(String(res.trailers['grpc-status'])).toBe('5');

    const entry = latestFor('/test.Echo/Boom');
    expect(entry.grpc.status).toBe(5);
    expect(entry.grpc.statusMessage).toBe('not found');
  });
});
