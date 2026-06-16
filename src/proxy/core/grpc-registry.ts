// Rebuilds the compiled proto bundle (sent from main) into live protobufjs
// roots and resolves a gRPC `:path` to the request/response message types used
// to decode its frames. Lives in the proxy core (Electron-free) because
// decoding happens in the worker, next to the bytes.
import protobuf from 'protobufjs';
import type { GrpcProtoBundle } from '../../shared/types';
import type { ProtoMessageType } from './grpc-frames';

export interface ResolvedMethod {
  specId: string;
  requestType: ProtoMessageType;
  responseType: ProtoMessageType;
}

export class GrpcRegistry {
  private readonly roots = new Map<string, protobuf.Root>();
  private readonly methodMap: GrpcProtoBundle['methodMap'];

  constructor(bundle: GrpcProtoBundle) {
    this.methodMap = bundle.methodMap;
    for (const spec of bundle.specs) {
      try {
        this.roots.set(spec.id, protobuf.Root.fromJSON(spec.namespace as protobuf.INamespace));
      } catch {
        // A namespace that fails to rebuild is skipped; its methods just won't resolve.
      }
    }
  }

  /** Number of gRPC methods this registry can decode. */
  get methodCount(): number {
    return Object.keys(this.methodMap).length;
  }

  /** Resolve the message types for a gRPC `:path`, or undefined when unmatched. */
  resolve(path: string): ResolvedMethod | undefined {
    const ref = this.methodMap[path];
    if (!ref) return undefined;
    const root = this.roots.get(ref.specId);
    if (!root) return undefined;
    try {
      return {
        specId: ref.specId,
        requestType: root.lookupType(ref.requestType),
        responseType: root.lookupType(ref.responseType),
      };
    } catch {
      return undefined;
    }
  }
}
