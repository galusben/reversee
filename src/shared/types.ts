// Types shared across main, preload, renderer, proxy worker, and MCP.
// This module must stay platform-neutral: no Electron and no node:* imports.

export type Protocol = 'http' | 'https';

/** Header map shaped like node's IncomingHttpHeaders without importing node types. */
export type Headers = Record<string, string | string[] | undefined>;

export interface ProxySettings {
  dest: string;
  destProtocol: Protocol;
  destPort: number;
  listenPort: number;
  listenProtocol: Protocol;
  /** Rewrite the Host header to the destination (menu: "Rewrite host"). */
  hostRewrite?: boolean;
  /** Rewrite absolute 3xx Location headers back to the listen address. */
  redirect?: boolean;
  /** Allow self-signed upstream certificates. Defaults to true (dev proxy use case). */
  allowSelfSignedUpstream?: boolean;
  requestInterceptor?: string;
  interceptRequest?: boolean;
  responseInterceptor?: string;
  interceptResponse?: boolean;
}

/** Parameters of the upstream request; mutated by request interceptors. */
export interface RequestParams {
  host?: string;
  path?: string;
  method?: string;
  port?: number;
  headers?: Headers;
  body?: Uint8Array;
  rejectUnauthorized?: boolean;
}

/** The resolved upstream the request was forwarded to (used by replay). */
export interface UpstreamTarget {
  protocol: Protocol;
  host: string;
  port: number;
}

export interface RequestView {
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  curl?: string;
  /** Where the proxy forwarded this request. */
  target?: UpstreamTarget;
  /** True when the stored body was cut at the display cap. */
  truncated?: boolean;
}

export interface ResponseView {
  statusCode?: number;
  headers: Headers;
  /** Decoded for display; the wire body is always passed through unmodified. */
  body?: Uint8Array | string;
  /** Set when displayed-body decompression failed (body falls back to raw bytes). */
  decodeError?: string;
  /** True when the stored body was cut at the display cap. */
  truncated?: boolean;
}

export interface Timings {
  start: Date | string;
  firstByte?: number;
  total?: number;
  dnsLookup?: number;
  tcpConnection?: number;
  tlsHandshake?: number;
}

export interface TrafficEntry {
  trafficId: number;
  request: RequestView;
  response: ResponseView;
  timings: Timings;
  connectorError?: unknown;
  /** Present when the call was detected as gRPC (content-type application/grpc*). */
  grpc?: GrpcView;
  /** True when this entry came from replay_request rather than live proxying. */
  replay?: boolean;
}

/** One length-prefixed gRPC message, decoded against a proto type when one matched. */
export interface GrpcMessage {
  /** Decoded protobuf as plain JSON; undefined when no proto type matched. */
  json?: unknown;
  /** Raw protobuf bytes of this message (after the 5-byte gRPC frame header). */
  raw?: Uint8Array;
  /** True when the frame's compression flag was set. */
  compressed?: boolean;
  /** Set when protobuf decoding failed (raw bytes are still available). */
  decodeError?: string;
}

/**
 * gRPC-specific view of a captured call. Messages arrays grow as streaming
 * frames arrive; a unary call has exactly one entry per direction.
 */
export interface GrpcView {
  /** The :path pseudo-header, e.g. "/package.Service/Method". */
  method: string;
  requestMessages: GrpcMessage[];
  responseMessages: GrpcMessage[];
  /** grpc-status trailer (0 = OK). Undefined until trailers arrive. */
  status?: number;
  /** grpc-message trailer (human-readable status detail). */
  statusMessage?: string;
  /** Id of the ProtoSpec whose types decoded this call, when matched. */
  matchedSpecId?: string;
}

/** A saved protobuf definition used to decode gRPC traffic. */
export interface ProtoSpec {
  id: string;
  /** User-facing label. */
  name: string;
  /** 'proto' = raw .proto text; 'descriptor' = compiled FileDescriptorSet (.desc). */
  source: 'proto' | 'descriptor';
  /** File name under userData/proto holding the raw bytes. */
  fileName: string;
  /**
   * Optional explicit method-path globs (e.g. "/myapp.Greeter/*") to scope this
   * spec. Empty/undefined means match any method this spec defines.
   */
  methodGlobs?: string[];
}

export interface ProtoSpecCompileError {
  id: string;
  name: string;
  error: string;
}

/** Resolves a gRPC `:path` to the protobuf types that decode its messages. */
export interface GrpcMethodTypeRef {
  specId: string;
  /** Fully-qualified protobuf type name (no leading dot). */
  requestType: string;
  responseType: string;
  /** Optional method-path globs scoping the owning spec. */
  methodGlobs?: string[];
}

/** One compiled spec as a serializable protobufjs namespace (INamespace). */
export interface GrpcProtoSpecBundle {
  id: string;
  /** protobufjs INamespace (root.toJSON()); typed loosely to keep this module dependency-free. */
  namespace: unknown;
}

/** Compiled proto specs shipped to the proxy worker for gRPC decoding. */
export interface GrpcProtoBundle {
  specs: GrpcProtoSpecBundle[];
  /** gRPC path -> type refs. */
  methodMap: Record<string, GrpcMethodTypeRef>;
}

export interface BreakpointRule {
  id: string;
  /** Regex source matched against the request URL. */
  path: string;
  methods: string[];
}

export interface BreakpointCompileError {
  id: string;
  path: string;
  error: string;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
