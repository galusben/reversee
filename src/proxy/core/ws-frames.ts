// Incremental WebSocket (RFC 6455) frame parser + message assembler, used to
// show the messages of a tunnelled WebSocket. It only ever reads a COPY of the
// bytes: the tunnel itself pipes the sockets untouched, so nothing here can
// corrupt the connection.
//
// Memory is bounded: at most `payloadLimit` bytes of each frame are kept.
import zlib from 'node:zlib';
import type { WsOpcode } from '../../shared/types';

/** Bytes of one message kept for display. */
export const WS_PAYLOAD_LIMIT = 32 * 1024;

const OPCODES: Record<number, WsOpcode | undefined> = {
  0x1: 'text',
  0x2: 'binary',
  0x8: 'close',
  0x9: 'ping',
  0xa: 'pong',
};

export interface WsFrame {
  fin: boolean;
  /** permessage-deflate marker (set on the first frame of a compressed message). */
  rsv1: boolean;
  /** Raw opcode: 0 = continuation, 1 = text, 2 = binary, 8 = close, 9 = ping, 10 = pong. */
  opcode: number;
  /** Unmasked payload, cut at the capture limit. */
  payload: Buffer;
  /** Full payload length on the wire. */
  size: number;
}

interface Partial {
  fin: boolean;
  rsv1: boolean;
  opcode: number;
  size: number;
  remaining: number;
  mask: Buffer | null;
  maskOffset: number;
  chunks: Buffer[];
  kept: number;
}

/** Splits a byte stream into frames. Tolerates any chunking, including split headers. */
export class WsFrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private current: Partial | null = null;

  constructor(private payloadLimit: number = WS_PAYLOAD_LIMIT) {}

  push(chunk: Buffer): WsFrame[] {
    const frames: WsFrame[] = [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    for (;;) {
      if (!this.current) {
        const header = this.readHeader();
        if (!header) break;
        this.current = header;
      }
      const cur = this.current;
      const take = Math.min(cur.remaining, this.buf.length);
      if (take > 0) {
        const room = this.payloadLimit - cur.kept;
        if (room > 0) {
          // Copy: unmasking mutates, and the source bytes are still in flight.
          const piece = Buffer.from(this.buf.subarray(0, Math.min(take, room)));
          if (cur.mask) {
            for (let i = 0; i < piece.length; i++) {
              piece[i] ^= cur.mask[(cur.maskOffset + i) & 3];
            }
          }
          cur.chunks.push(piece);
          cur.kept += piece.length;
        }
        cur.maskOffset += take;
        cur.remaining -= take;
        this.buf = this.buf.subarray(take);
      }
      if (cur.remaining > 0) break; // need more bytes
      frames.push({
        fin: cur.fin,
        rsv1: cur.rsv1,
        opcode: cur.opcode,
        payload: Buffer.concat(cur.chunks),
        size: cur.size,
      });
      this.current = null;
    }
    return frames;
  }

  private readHeader(): Partial | null {
    const buf = this.buf;
    if (buf.length < 2) return null;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      length = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
      offset = 10;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = Buffer.from(buf.subarray(offset, offset + 4));
      offset += 4;
    }
    const header: Partial = {
      fin: (buf[0] & 0x80) !== 0,
      rsv1: (buf[0] & 0x40) !== 0,
      opcode: buf[0] & 0x0f,
      size: length,
      remaining: length,
      mask,
      maskOffset: 0,
      chunks: [],
      kept: 0,
    };
    this.buf = buf.subarray(offset);
    return header;
  }
}

export interface AssembledMessage {
  opcode: WsOpcode;
  /** Text for text frames and close reasons; undefined for binary payloads. */
  text?: string;
  size: number;
  truncated?: boolean;
  closeCode?: number;
}

/**
 * Turns one direction's frames into whole messages: joins fragments and
 * inflates permessage-deflate payloads. `onMessage` fires synchronously, in
 * wire order; a compressed message is announced without its text, which is
 * filled into the same object once inflated (then `onChange` fires).
 */
export class WsMessageAssembler {
  private parser: WsFrameParser;
  private fragments: {
    opcode: number;
    rsv1: boolean;
    chunks: Buffer[];
    kept: number;
    size: number;
  } | null = null;
  private inflater: zlib.InflateRaw | null = null;
  /** Serializes inflation: the stream is stateful, one message at a time. */
  private queue: Promise<void> = Promise.resolve();
  private inflateBroken = false;

  constructor(
    private onMessage: (message: AssembledMessage) => void,
    private options: { deflate?: boolean; payloadLimit?: number; onChange?: () => void } = {}
  ) {
    this.parser = new WsFrameParser(options.payloadLimit ?? WS_PAYLOAD_LIMIT);
  }

  push(chunk: Buffer): void {
    for (const frame of this.parser.push(chunk)) this.onFrame(frame);
  }

  destroy(): void {
    this.inflater?.destroy();
    this.inflater = null;
  }

  private get limit(): number {
    return this.options.payloadLimit ?? WS_PAYLOAD_LIMIT;
  }

  private onFrame(frame: WsFrame): void {
    // Control frames may be interleaved with the fragments of a data message.
    if (frame.opcode >= 0x8) {
      this.deliver(frame.opcode, frame.payload, frame.size, false);
      return;
    }
    if (frame.opcode !== 0) {
      this.fragments = { opcode: frame.opcode, rsv1: frame.rsv1, chunks: [], kept: 0, size: 0 };
    }
    const frag = this.fragments;
    if (!frag) return; // continuation without a start: we joined mid-message
    // The cap is per message, not per fragment.
    const room = this.limit - frag.kept;
    if (room > 0) {
      const piece = frame.payload.length > room ? frame.payload.subarray(0, room) : frame.payload;
      frag.chunks.push(piece);
      frag.kept += piece.length;
    }
    frag.size += frame.size;
    if (!frame.fin) return;
    this.fragments = null;
    this.deliver(frag.opcode, Buffer.concat(frag.chunks), frag.size, frag.rsv1);
  }

  private deliver(opcode: number, payload: Buffer, size: number, compressed: boolean): void {
    const kind = OPCODES[opcode];
    if (!kind) return;
    const cut = payload.length < size;
    const message: AssembledMessage = { opcode: kind, size };

    if (!(compressed && this.options.deflate)) {
      this.fill(message, payload, cut);
      this.onMessage(message);
      return;
    }
    // A cut payload cannot be inflated, and skipping it would desynchronize
    // the shared sliding window — so decompression stops for this direction.
    if (cut) this.inflateBroken = true;
    if (this.inflateBroken) {
      message.truncated = true;
      this.onMessage(message);
      return;
    }
    // Announce now so the message keeps its place in arrival order (also
    // relative to the other direction); the text follows once inflated.
    this.onMessage(message);
    this.queue = this.queue
      .then(() => this.inflate(payload))
      .then(
        (inflated) => this.fill(message, inflated, false),
        () => {
          this.inflateBroken = true;
          message.truncated = true;
        }
      )
      .then(() => this.options.onChange?.());
  }

  /** Resolves once every announced message has its final content. */
  idle(): Promise<void> {
    return this.queue;
  }

  private fill(message: AssembledMessage, payload: Buffer, cut: boolean): void {
    let body = payload;
    if (body.length > this.limit) {
      body = body.subarray(0, this.limit);
      cut = true;
    }
    if (cut) message.truncated = true;
    if (message.opcode === 'close') {
      if (body.length >= 2) {
        message.closeCode = body.readUInt16BE(0);
        const reason = body.subarray(2).toString('utf8');
        if (reason) message.text = reason;
      }
    } else if (message.opcode === 'text') {
      message.text = body.toString('utf8');
    }
  }

  /** One message through the direction's persistent raw-inflate stream. */
  private inflate(payload: Buffer): Promise<Buffer> {
    const inflater = (this.inflater ??= zlib.createInflateRaw());
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const onData = (c: Buffer): void => {
        // Keep draining past the cap so the window stays in sync.
        if (total < this.limit) chunks.push(c);
        total += c.length;
      };
      const cleanup = (): void => {
        inflater.removeListener('data', onData);
        inflater.removeListener('error', onError);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      inflater.on('data', onData);
      inflater.on('error', onError);
      inflater.write(payload);
      // The sender strips this trailer from every message (RFC 7692 §7.2.1).
      inflater.write(Buffer.from([0x00, 0x00, 0xff, 0xff]));
      inflater.flush(() => {
        cleanup();
        resolve(Buffer.concat(chunks));
      });
    });
  }
}
