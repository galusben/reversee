// Storage and compilation of saved protobuf specs used to decode gRPC traffic.
//
// Hybrid, file-based storage under a single directory (default
// userData/proto): an index.json holds the ProtoSpec metadata and each spec's
// raw bytes live in its own file (<id>.proto for text, <id>.desc for a compiled
// FileDescriptorSet). This keeps potentially large proto text out of the
// settings JSON and makes the store trivially testable headlessly — it takes a
// directory and imports no Electron.
//
// compile() turns every saved spec into a serializable bundle (one protobufjs
// namespace per spec) plus a method map keyed by gRPC path
// (/package.Service/Method), which the proxy worker rebuilds to decode messages.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import protobuf from 'protobufjs';
import descriptor from 'protobufjs/ext/descriptor';
import type {
  GrpcMethodTypeRef,
  GrpcProtoBundle,
  GrpcProtoSpecBundle,
  ProtoSpec,
  ProtoSpecCompileError,
} from '../../shared/types';

/** The descriptor extension augments Root with fromDescriptor at runtime but doesn't type the static. */
const RootWithDescriptor = protobuf.Root as typeof protobuf.Root & {
  fromDescriptor(descriptorSet: unknown): protobuf.Root;
};

export interface AddProtoSpec {
  name: string;
  source: 'proto' | 'descriptor';
  /** Raw .proto text (source 'proto') or FileDescriptorSet bytes (source 'descriptor'). */
  content: string | Uint8Array;
  methodGlobs?: string[];
}

/** compile() output: the worker bundle plus any per-spec compile errors. */
export interface ProtoCompileResult extends GrpcProtoBundle {
  errors: ProtoSpecCompileError[];
}

const INDEX_FILE = 'index.json';

function extFor(source: ProtoSpec['source']): string {
  return source === 'proto' ? 'proto' : 'desc';
}

export class ProtoStore {
  constructor(private readonly dir: string) {}

  private indexPath(): string {
    return path.join(this.dir, INDEX_FILE);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list(): ProtoSpec[] {
    try {
      const raw = fs.readFileSync(this.indexPath(), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ProtoSpec[]) : [];
    } catch {
      return []; // no index yet
    }
  }

  private writeIndex(specs: ProtoSpec[]): void {
    this.ensureDir();
    fs.writeFileSync(this.indexPath(), JSON.stringify(specs, null, 2), 'utf8');
  }

  readContent(spec: ProtoSpec): Buffer {
    return fs.readFileSync(path.join(this.dir, spec.fileName));
  }

  add(input: AddProtoSpec): ProtoSpec {
    const id = randomUUID();
    const fileName = `${id}.${extFor(input.source)}`;
    const spec: ProtoSpec = {
      id,
      name: input.name,
      source: input.source,
      fileName,
      ...(input.methodGlobs && input.methodGlobs.length ? { methodGlobs: input.methodGlobs } : {}),
    };
    this.ensureDir();
    fs.writeFileSync(path.join(this.dir, fileName), input.content);
    this.writeIndex([...this.list(), spec]);
    return spec;
  }

  update(id: string, patch: Partial<Pick<ProtoSpec, 'name' | 'methodGlobs'>>): ProtoSpec | null {
    const specs = this.list();
    const index = specs.findIndex((s) => s.id === id);
    if (index < 0) return null;
    const updated: ProtoSpec = { ...specs[index], ...patch };
    specs[index] = updated;
    this.writeIndex(specs);
    return updated;
  }

  remove(id: string): boolean {
    const specs = this.list();
    const spec = specs.find((s) => s.id === id);
    if (!spec) return false;
    try {
      fs.rmSync(path.join(this.dir, spec.fileName));
    } catch {
      // file already gone; drop the metadata regardless
    }
    this.writeIndex(specs.filter((s) => s.id !== id));
    return true;
  }

  /**
   * Compile every saved spec into per-spec namespaces and a gRPC path -> type
   * map. A spec that fails to compile is reported in `errors` and skipped; the
   * others still compile.
   */
  compile(): ProtoCompileResult {
    const specs: GrpcProtoSpecBundle[] = [];
    const methodMap: Record<string, GrpcMethodTypeRef> = {};
    const errors: ProtoSpecCompileError[] = [];

    for (const spec of this.list()) {
      try {
        const content = this.readContent(spec);
        const root =
          spec.source === 'proto'
            ? protobuf.parse(content.toString('utf8'), { keepCase: false }).root
            : RootWithDescriptor.fromDescriptor(descriptor.FileDescriptorSet.decode(content));
        root.resolveAll();
        for (const ref of collectMethods(root)) {
          methodMap[ref.path] = {
            specId: spec.id,
            requestType: ref.requestType,
            responseType: ref.responseType,
            ...(spec.methodGlobs ? { methodGlobs: spec.methodGlobs } : {}),
          };
        }
        specs.push({ id: spec.id, namespace: root.toJSON() });
      } catch (e) {
        errors.push({ id: spec.id, name: spec.name, error: (e as Error).message });
      }
    }
    return { specs, methodMap, errors };
  }
}

/** Strip protobufjs' leading-dot fully-qualified names ('.pkg.Type' -> 'pkg.Type'). */
function fq(name: string): string {
  return name.replace(/^\./, '');
}

interface CollectedMethod {
  path: string; // /pkg.Service/Method
  requestType: string;
  responseType: string;
}

/** Walk a root for services and yield one entry per RPC method. */
export function collectMethods(root: protobuf.Root): CollectedMethod[] {
  const out: CollectedMethod[] = [];
  const visit = (ns: protobuf.NamespaceBase): void => {
    for (const obj of ns.nestedArray) {
      if (obj instanceof protobuf.Service) {
        const service = fq(obj.fullName);
        for (const method of obj.methodsArray) {
          out.push({
            path: `/${service}/${method.name}`,
            requestType: fq(method.resolvedRequestType?.fullName ?? method.requestType),
            responseType: fq(method.resolvedResponseType?.fullName ?? method.responseType),
          });
        }
      }
      if (obj instanceof protobuf.Namespace) {
        visit(obj);
      }
    }
  };
  visit(root);
  return out;
}
