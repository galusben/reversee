// Bounded copy of a response body for the traffic view. The wire body is
// streamed to the client untouched; this keeps at most `limit` bytes of it for
// display and decompresses that copy incrementally, so a multi-gigabyte
// download or an endless event stream costs a fixed amount of memory.
import zlib from 'node:zlib';
import type { Transform } from 'node:stream';

/** Matches the traffic store's display cap. */
export const CAPTURE_LIMIT = 2 * 1024 * 1024;

type DecoderFactory = () => Transform;

const zstd = (zlib as unknown as { createZstdDecompress?: DecoderFactory }).createZstdDecompress;

const DECODERS: Record<string, DecoderFactory | undefined> = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  br: () => zlib.createBrotliDecompress(),
  deflate: () => zlib.createInflate(),
  // Available from Node 22.15; absent on older runtimes.
  zstd: zstd ? () => zstd() : undefined,
};

export interface CaptureSnapshot {
  /** Decoded bytes when a decoder is active and healthy, else the raw bytes. */
  body: Buffer;
  truncated: boolean;
  decodeError?: string;
}

function headerToken(value: unknown): string {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' ? text.trim().toLowerCase() : '';
}

export class BodyCapture {
  /** Total bytes written, i.e. the size on the wire. */
  size = 0;

  private raw: Buffer[] = [];
  private rawBytes = 0;
  private decoded: Buffer[] = [];
  private decodedBytes = 0;
  private decoder: Transform | null = null;
  private decoderDone: Promise<void> | null = null;
  private truncated = false;
  private decodeError: string | undefined;

  constructor(
    contentEncoding: unknown,
    private limit: number = CAPTURE_LIMIT
  ) {
    const factory = DECODERS[headerToken(contentEncoding)];
    if (!factory) return;
    const decoder = factory();
    this.decoder = decoder;
    this.decoderDone = new Promise((resolve) => {
      decoder.on('data', (chunk: Buffer) => this.keepDecoded(chunk));
      decoder.on('end', resolve);
      decoder.on('close', resolve);
      decoder.on('error', (err: Error) => {
        // Keep the first failure; later writes to the dead stream are skipped.
        this.decodeError ??= err.message;
        this.decoder = null;
        resolve();
      });
    });
  }

  private keepDecoded(chunk: Buffer): void {
    const room = this.limit - this.decodedBytes;
    if (room <= 0) {
      this.stopDecoding();
      return;
    }
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.decoded.push(piece);
    this.decodedBytes += piece.length;
    if (chunk.length > room) this.stopDecoding();
  }

  /** The display cap was reached: stop inflating, we have all we will show. */
  private stopDecoding(): void {
    this.truncated = true;
    const decoder = this.decoder;
    this.decoder = null;
    decoder?.destroy();
  }

  write(chunk: Buffer): void {
    this.size += chunk.length;
    const room = this.limit - this.rawBytes;
    if (room > 0) {
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.raw.push(piece);
      this.rawBytes += piece.length;
    }
    if (this.decoder) this.decoder.write(chunk);
  }

  /** What has been captured so far; safe to call while the body is streaming. */
  snapshot(): CaptureSnapshot {
    const decoding = this.decoderDone !== null && !this.decodeError;
    return {
      body: Buffer.concat(decoding ? this.decoded : this.raw),
      truncated: decoding ? this.truncated : this.size > this.rawBytes,
      decodeError: this.decodeError,
    };
  }

  /** Flushes the decoder and returns the final capture. */
  async finish(): Promise<CaptureSnapshot> {
    if (this.decoder) this.decoder.end();
    if (this.decoderDone) await this.decoderDone;
    return this.snapshot();
  }

  /** Releases the decoder when the exchange is abandoned mid-body. */
  destroy(): void {
    this.decoder?.destroy();
    this.decoder = null;
  }
}

const SYNC_DECODERS: Record<string, ((body: Buffer) => Buffer) | undefined> = {
  gzip: (b) => zlib.gunzipSync(b),
  'x-gzip': (b) => zlib.gunzipSync(b),
  br: (b) => zlib.brotliDecompressSync(b),
  deflate: (b) => zlib.inflateSync(b),
};

/**
 * Decompresses a complete body for editing (response breakpoints). Returns
 * null when the encoding is absent, unknown, or the body does not decode —
 * the caller then keeps the original bytes and header.
 */
export function decodeBodySync(body: Buffer, contentEncoding: unknown): Buffer | null {
  const decode = SYNC_DECODERS[headerToken(contentEncoding)];
  if (!decode) return null;
  try {
    return decode(body);
  } catch {
    return null;
  }
}
