// Unit tests for GrpcRegistry: rebuilding the compiled bundle and resolving a
// gRPC :path to decodable message types end-to-end with ProtoStore.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProtoStore } from '../../src/main/proto/proto-store';
import { GrpcRegistry } from '../../src/proxy/core/grpc-registry';
import { encodeGrpcFrame, decodeMessages } from '../../src/proxy/core/grpc-frames';

const GREETER = `
  syntax = "proto3";
  package greet;
  message HelloRequest { string name = 1; }
  message HelloReply { string message = 1; }
  service Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }
`;

let dir;
let registry;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-reg-'));
  const store = new ProtoStore(dir);
  store.add({ name: 'Greeter', source: 'proto', content: GREETER });
  const { specs, methodMap } = store.compile();
  registry = new GrpcRegistry({ specs, methodMap });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GrpcRegistry', () => {
  it('reports the method count', () => {
    expect(registry.methodCount).toBe(1);
  });

  it('resolves a known :path to message types and decodes a frame', () => {
    const resolved = registry.resolve('/greet.Greeter/SayHello');
    expect(resolved).toBeTruthy();
    const wire = encodeGrpcFrame(Buffer.from(resolved.requestType.encode({ name: 'ada' }).finish()));
    const [msg] = decodeMessages(wire, resolved.requestType);
    expect(msg.json).toEqual({ name: 'ada' });
  });

  it('returns undefined for an unknown :path', () => {
    expect(registry.resolve('/nope.Service/Method')).toBeUndefined();
  });
});
