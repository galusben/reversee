// Unit tests for ProtoStore: CRUD on disk, .proto text compilation, .desc
// FileDescriptorSet loading, method-map building, and per-spec error reporting.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import protobuf from 'protobufjs';
import descriptor from 'protobufjs/ext/descriptor';
import { ProtoStore } from '../../src/main/proto/proto-store';

const GREETER = `
  syntax = "proto3";
  package greet;
  message HelloRequest { string name = 1; }
  message HelloReply { string message = 1; }
  service Greeter {
    rpc SayHello (HelloRequest) returns (HelloReply);
    rpc SayHelloStream (HelloRequest) returns (stream HelloReply);
  }
`;

let dir;
let store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-proto-'));
  store = new ProtoStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProtoStore CRUD', () => {
  it('starts empty', () => {
    expect(store.list()).toEqual([]);
  });

  it('adds, persists, and removes a spec', () => {
    const spec = store.add({ name: 'Greeter', source: 'proto', content: GREETER });
    expect(spec.id).toBeTruthy();
    expect(store.list()).toHaveLength(1);
    // A fresh store over the same dir sees the persisted spec + file.
    expect(new ProtoStore(dir).list()).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, spec.fileName))).toBe(true);

    expect(store.remove(spec.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, spec.fileName))).toBe(false);
  });

  it('updates the name', () => {
    const spec = store.add({ name: 'old', source: 'proto', content: GREETER });
    store.update(spec.id, { name: 'new' });
    expect(store.list()[0].name).toBe('new');
  });
});

describe('ProtoStore.compile', () => {
  it('builds a method map from .proto text', () => {
    store.add({ name: 'Greeter', source: 'proto', content: GREETER });
    const { methodMap, errors } = store.compile();
    expect(errors).toEqual([]);
    expect(Object.keys(methodMap).sort()).toEqual([
      '/greet.Greeter/SayHello',
      '/greet.Greeter/SayHelloStream',
    ]);
    expect(methodMap['/greet.Greeter/SayHello']).toMatchObject({
      requestType: 'greet.HelloRequest',
      responseType: 'greet.HelloReply',
    });
  });

  it('loads a compiled .desc FileDescriptorSet', () => {
    const root = protobuf.parse(GREETER).root;
    root.resolveAll();
    const desc = descriptor.FileDescriptorSet.encode(root.toDescriptor('proto3')).finish();
    store.add({ name: 'Greeter (desc)', source: 'descriptor', content: desc });
    const { methodMap, errors } = store.compile();
    expect(errors).toEqual([]);
    expect(methodMap['/greet.Greeter/SayHello'].responseType).toBe('greet.HelloReply');
  });

  it('reports a bad spec and still compiles the good ones', () => {
    store.add({ name: 'broken', source: 'proto', content: 'syntax = "proto3"; message {' });
    store.add({ name: 'Greeter', source: 'proto', content: GREETER });
    const { methodMap, errors } = store.compile();
    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe('broken');
    expect(methodMap['/greet.Greeter/SayHello']).toBeTruthy();
  });

  it('produces a serializable namespace the worker can rebuild', () => {
    store.add({ name: 'Greeter', source: 'proto', content: GREETER });
    const { specs } = store.compile();
    const rebuilt = protobuf.Root.fromJSON(specs[0].namespace);
    expect(rebuilt.lookupType('greet.HelloRequest')).toBeTruthy();
  });
});
