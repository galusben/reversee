// Unit tests for gRPC message framing: one-shot parse, incremental accumulator,
// compression, truncation tolerance, and decode-against-type behavior.
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import protobuf from 'protobufjs';
import {
  parseGrpcFrames,
  FrameAccumulator,
  encodeGrpcFrame,
  decodeFrame,
  decodeMessages,
} from '../../src/proxy/core/grpc-frames';

const frame = (data, compressed = false) => encodeGrpcFrame(Buffer.from(data), compressed);

describe('parseGrpcFrames', () => {
  it('parses multiple complete frames', () => {
    const buf = Buffer.concat([frame('one'), frame('two'), frame('three')]);
    const { frames, rest } = parseGrpcFrames(buf);
    expect(frames.map((f) => f.data.toString())).toEqual(['one', 'two', 'three']);
    expect(rest).toHaveLength(0);
  });

  it('leaves a truncated trailing frame in rest', () => {
    const whole = Buffer.concat([frame('done'), frame('partial')]);
    const cut = whole.subarray(0, whole.length - 3); // drop 3 bytes of "partial"
    const { frames, rest } = parseGrpcFrames(cut);
    expect(frames.map((f) => f.data.toString())).toEqual(['done']);
    expect(rest.length).toBeGreaterThan(0);
  });

  it('flags the compression bit', () => {
    const { frames } = parseGrpcFrames(frame('z', true));
    expect(frames[0].compressed).toBe(true);
  });

  it('returns no frames for a sub-header buffer', () => {
    const { frames, rest } = parseGrpcFrames(Buffer.from([0, 0, 0]));
    expect(frames).toHaveLength(0);
    expect(rest).toHaveLength(3);
  });
});

describe('FrameAccumulator', () => {
  it('emits frames as bytes arrive across chunk boundaries', () => {
    const whole = Buffer.concat([frame('alpha'), frame('beta')]);
    const acc = new FrameAccumulator();
    const got = [];
    // Feed one byte at a time to stress the boundary handling.
    for (const byte of whole) got.push(...acc.push(Buffer.from([byte])));
    expect(got.map((f) => f.data.toString())).toEqual(['alpha', 'beta']);
    expect(acc.pending).toHaveLength(0);
  });
});

describe('decodeFrame', () => {
  const root = protobuf.parse(`
    syntax = "proto3";
    package test;
    message Hello { string name = 1; int32 count = 2; }
  `).root;
  const Hello = root.lookupType('test.Hello');

  it('decodes a protobuf message to JSON', () => {
    const payload = Buffer.from(Hello.encode({ name: 'ada', count: 3 }).finish());
    const [msg] = decodeMessages(encodeGrpcFrame(payload), Hello);
    expect(msg.json).toEqual({ name: 'ada', count: 3 });
    expect(msg.decodeError).toBeUndefined();
  });

  it('gunzips a compressed frame before decoding', () => {
    const payload = Buffer.from(Hello.encode({ name: 'gz', count: 1 }).finish());
    const gz = zlib.gzipSync(payload);
    const [msg] = parseGrpcFrames(encodeGrpcFrame(gz, true)).frames.map((f) => decodeFrame(f, Hello));
    expect(msg.json).toEqual({ name: 'gz', count: 1 });
  });

  it('keeps raw bytes and no json when no type is supplied', () => {
    const [msg] = decodeMessages(frame('rawbytes'));
    expect(msg.json).toBeUndefined();
    expect(Buffer.from(msg.raw).toString()).toBe('rawbytes');
  });

  it('reports a decode error without throwing on garbage', () => {
    const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]);
    const [msg] = decodeMessages(encodeGrpcFrame(garbage), Hello);
    expect(msg.decodeError).toBeTruthy();
    expect(Buffer.from(msg.raw)).toHaveLength(5);
  });
});
