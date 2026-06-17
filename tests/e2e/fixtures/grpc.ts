// gRPC e2e helpers: a hand-rolled h2c (cleartext HTTP/2) Greeter upstream, an
// h2c gRPC client, proto-spec seeding into a profile dir, and gRPC framing.
// Kept dependency-light (node:http2 + protobufjs) so the e2e doesn't need a
// real gRPC stack.
import http2 from 'node:http2';
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';

export const GREETER_PROTO = `syntax = "proto3";
package greet;

message HelloRequest { string name = 1; }
message HelloReply { string message = 1; }

service Greeter {
  // Unary: one request, one reply.
  rpc SayHello (HelloRequest) returns (HelloReply);
  // Server streaming: one request, many replies.
  rpc SayManyHellos (HelloRequest) returns (stream HelloReply);
}
`;

const root = protobuf.parse(GREETER_PROTO).root;
root.resolveAll();
const HelloRequest = root.lookupType('greet.HelloRequest');
const HelloReply = root.lookupType('greet.HelloReply');

/** Wrap protobuf bytes in a gRPC length-prefixed frame ([1B flag][4B len][msg]). */
function frame(buf: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(buf.length, 1);
  return Buffer.concat([header, buf]);
}

/** Parse all complete frames out of a buffer. */
function unframe(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const len = buf.readUInt32BE(offset + 1);
    if (offset + 5 + len > buf.length) break;
    out.push(buf.subarray(offset + 5, offset + 5 + len));
    offset += 5 + len;
  }
  return out;
}

const helloRequest = (name: string): Buffer => frame(Buffer.from(HelloRequest.encode({ name }).finish()));
const helloReply = (message: string): Buffer => frame(Buffer.from(HelloReply.encode({ message }).finish()));

export interface GrpcUpstream {
  port: number;
  close(): Promise<void>;
}

/** A minimal Greeter gRPC server over cleartext HTTP/2. */
export function startGrpcUpstream(): Promise<GrpcUpstream> {
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const path = String(headers[':path']);
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      const [reqFrame] = unframe(Buffer.concat(chunks));
      const name = (HelloRequest.decode(reqFrame) as unknown as { name: string }).name;
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc+proto' },
        { waitForTrailers: true }
      );
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', 'grpc-message': 'OK' }));
      if (path === '/greet.Greeter/SayManyHellos') {
        for (let i = 1; i <= 3; i++) stream.write(helloReply(`Hello ${name} #${i}`));
      } else {
        stream.write(helloReply(`Hello, ${name}`));
      }
      stream.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

export interface GrpcResult {
  status: number;
  messages: string[];
}

/** Drive one gRPC call over h2c against the proxy; resolves with replies + status. */
export function grpcCall(port: number, callPath: string, name: string): Promise<GrpcResult> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`http://127.0.0.1:${port}`);
    session.on('error', reject);
    const stream = session.request({
      ':method': 'POST',
      ':path': callPath,
      'content-type': 'application/grpc+proto',
      te: 'trailers',
    });
    const chunks: Buffer[] = [];
    let status = -1;
    stream.on('response', (h) => {
      if (h['grpc-status'] !== undefined) status = Number(h['grpc-status']); // Trailers-Only
    });
    stream.on('trailers', (t) => {
      if (t['grpc-status'] !== undefined) status = Number(t['grpc-status']);
    });
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      session.close();
      const messages = unframe(Buffer.concat(chunks)).map(
        (f) => (HelloReply.decode(f) as unknown as { message: string }).message
      );
      resolve({ status, messages });
    });
    stream.on('error', reject);
    stream.end(helloRequest(name));
  });
}

/**
 * Seed a saved proto spec into a profile dir (the same on-disk layout ProtoStore
 * reads), so the app decodes gRPC without driving the native import dialog.
 */
export function seedProtoSpec(userDataDir: string): void {
  const dir = path.join(userDataDir, 'proto');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'greeter.proto'), GREETER_PROTO);
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify([{ id: 'greeter', name: 'greeter.proto', source: 'proto', fileName: 'greeter.proto' }])
  );
}
