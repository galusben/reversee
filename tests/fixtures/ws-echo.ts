// A tiny hand-rolled WebSocket server for tests (unit + e2e), so the suite
// needs no WebSocket dependency and does not validate the proxy's frame parser
// with itself. On connect it sends "welcome"; every text message "x" is
// answered with "echo: x"; the message "bye" makes the server close (1000).
// With `deflate` it negotiates permessage-deflate (no context takeover).
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

export interface WsEchoServer {
  port: number;
  /** Text messages received from clients, in order. */
  received: string[];
  /** Headers of each upgrade request. */
  handshakes: http.IncomingHttpHeaders[];
  close(): Promise<void>;
}

export function encodeFrame(
  opcode: number,
  payload: Buffer,
  { rsv1 = false, mask = false, fin = true } = {}
): Buffer {
  const head: number[] = [(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode];
  const maskBit = mask ? 0x80 : 0;
  if (payload.length < 126) head.push(maskBit | payload.length);
  else if (payload.length < 65536)
    head.push(maskBit | 126, payload.length >> 8, payload.length & 0xff);
  else {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(payload.length));
    head.push(maskBit | 127, ...len);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), key, masked]);
}

export function startWsEchoServer({
  deflate = false,
  rejectWith,
}: { deflate?: boolean; rejectWith?: number } = {}): Promise<WsEchoServer> {
  const received: string[] = [];
  const handshakes: http.IncomingHttpHeaders[] = [];
  const sockets = new Set<Duplex>();
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  });

  server.on('upgrade', (req, socket) => {
    handshakes.push(req.headers);
    if (rejectWith) {
      socket.end(
        `HTTP/1.1 ${rejectWith} Nope\r\ncontent-type: text/plain\r\ncontent-length: 6\r\n\r\ndenied`
      );
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + GUID)
      .digest('base64');
    const useDeflate =
      deflate &&
      String(req.headers['sec-websocket-extensions'] ?? '').includes('permessage-deflate');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (useDeflate
          ? 'Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n'
          : '') +
        '\r\n'
    );

    const sendText = (text: string): void => {
      const data = Buffer.from(text);
      if (!useDeflate) {
        socket.write(encodeFrame(0x1, data));
        return;
      }
      const deflated = zlib.deflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      socket.write(encodeFrame(0x1, deflated.subarray(0, deflated.length - 4), { rsv1: true }));
    };

    sendText('welcome');

    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const rsv1 = (buffer[0] & 0x40) !== 0;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + 4 + length) return;
        const key = buffer.subarray(offset, offset + 4);
        let payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
        buffer = buffer.subarray(offset + 4 + length);

        if (opcode === 0x8) {
          socket.end(encodeFrame(0x8, payload));
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeFrame(0xa, payload));
          continue;
        }
        if (opcode !== 0x1) continue;
        if (rsv1) {
          payload = zlib.inflateRawSync(Buffer.concat([payload, TRAILER]), {
            finishFlush: zlib.constants.Z_SYNC_FLUSH,
          });
        }
        const text = payload.toString();
        received.push(text);
        if (text === 'bye') {
          const close = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('server done')]);
          socket.end(encodeFrame(0x8, close));
          return;
        }
        sendText(`echo: ${text}`);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        received,
        handshakes,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
