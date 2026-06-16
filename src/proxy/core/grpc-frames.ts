// gRPC message framing. On the wire a gRPC HTTP/2 DATA stream is a sequence of
// length-prefixed messages, each: [1 byte compression flag][4 byte big-endian
// length][length bytes of (possibly gzip-compressed) protobuf]. A single DATA
// body can carry many messages (streaming), and a chunk boundary can fall in
// the middle of one — so this module offers both a one-shot parser (whole
// buffer) and an incremental accumulator (streaming).
//
// Pure Node (node:zlib only); no Electron, no protobufjs import. Decoding to
// JSON takes a structurally-typed protobuf message type so callers can inject a
// real protobufjs Type without this module depending on the library.
import zlib from 'node:zlib';
import type { GrpcMessage } from '../../shared/types';

export const GRPC_HEADER_LEN = 5;

export interface GrpcFrame {
  /** True when the message bytes are gzip-compressed (frame flag == 1). */
  compressed: boolean;
  /** Message bytes, still compressed if `compressed` is true. */
  data: Buffer;
}

/** Minimal shape of a protobufjs Type, so we needn't import protobufjs here. */
export interface ProtoMessageType {
  decode(reader: Uint8Array): unknown;
  toObject(message: unknown, options?: Record<string, unknown>): Record<string, unknown>;
}

/** toObject options that render protobuf in a stable, JSON-friendly way. */
export const TO_OBJECT_OPTIONS: Record<string, unknown> = {
  defaults: true,
  longs: String,
  bytes: String, // base64
  enums: String,
  arrays: true,
  objects: true,
};

/**
 * Parse all complete frames in a buffer. A trailing partial frame (chunk
 * boundary mid-message) is left in `rest`; pass it back in prepended to the next
 * buffer, or ignore it for a known-complete body.
 */
export function parseGrpcFrames(buf: Buffer): { frames: GrpcFrame[]; rest: Buffer } {
  const frames: GrpcFrame[] = [];
  let offset = 0;
  while (offset + GRPC_HEADER_LEN <= buf.length) {
    const compressed = buf[offset] === 1;
    const length = buf.readUInt32BE(offset + 1);
    const end = offset + GRPC_HEADER_LEN + length;
    if (end > buf.length) break; // incomplete trailing frame
    frames.push({ compressed, data: buf.subarray(offset + GRPC_HEADER_LEN, end) });
    offset = end;
  }
  return { frames, rest: buf.subarray(offset) };
}

/**
 * Incremental framer for streaming bodies. Feed chunks as they arrive; each
 * `push` returns the frames that became complete with this chunk.
 */
export class FrameAccumulator {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): GrpcFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const { frames, rest } = parseGrpcFrames(this.buffer);
    this.buffer = rest;
    return frames;
  }

  /** Bytes buffered but not yet a complete frame (non-zero only on truncation). */
  get pending(): Buffer {
    return this.buffer;
  }
}

/** Re-frame a protobuf message into gRPC wire format (5-byte header + bytes). */
export function encodeGrpcFrame(data: Buffer, compressed = false): Buffer {
  const header = Buffer.alloc(GRPC_HEADER_LEN);
  header[0] = compressed ? 1 : 0;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

/**
 * Decode one frame into a GrpcMessage. Decompresses if needed, decodes against
 * `type` when supplied, and never throws — failures land in `decodeError` with
 * the raw bytes preserved.
 */
export function decodeFrame(frame: GrpcFrame, type?: ProtoMessageType): GrpcMessage {
  let raw = frame.data;
  if (frame.compressed) {
    try {
      raw = zlib.gunzipSync(frame.data);
    } catch (e) {
      return {
        raw: frame.data,
        compressed: true,
        decodeError: `gunzip failed: ${(e as Error).message}`,
      };
    }
  }
  const message: GrpcMessage = { raw, compressed: frame.compressed };
  if (type) {
    try {
      message.json = type.toObject(type.decode(raw), TO_OBJECT_OPTIONS);
    } catch (e) {
      message.decodeError = (e as Error).message;
    }
  }
  return message;
}

/** Decode every frame in a buffer (convenience for buffered/unary bodies). */
export function decodeMessages(buf: Buffer, type?: ProtoMessageType): GrpcMessage[] {
  return parseGrpcFrames(buf).frames.map((frame) => decodeFrame(frame, type));
}
