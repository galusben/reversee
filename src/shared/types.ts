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
  /**
   * Run an HTTP/2 listener so native gRPC can be proxied and decoded. When the
   * listen protocol is https the server negotiates h2 via ALPN (HTTP/1.1 still
   * works); when http it speaks cleartext h2c (prior knowledge).
   */
  enableGrpc?: boolean;
  /**
   * "Capture anything": act as a regular HTTP proxy (absolute-form requests and
   * CONNECT) so each request goes to the server the client asked for, instead
   * of forwarding everything to `dest`. Route rules still take precedence.
   */
  captureAll?: boolean;
  /**
   * Seconds to wait for the upstream's response headers before answering 504.
   * 0 disables the timeout. Applies until the first response byte only, so
   * long-lived streams (SSE, long-poll bodies) are never cut off.
   */
  upstreamTimeoutSec?: number;
  /** Per-request destination overrides; the first matching enabled rule wins. */
  routes?: RouteRule[];
  /** Canned responses served without contacting the upstream. */
  mocks?: MockRule[];
  /** PEM client certificate + key presented to https upstreams (mutual TLS). */
  upstreamClientCert?: { cert: string; key: string };
}

/**
 * Sends matching requests to a different upstream than the default
 * destination. Both patterns are regular expressions; an empty pattern
 * matches everything.
 */
export interface RouteRule {
  id: string;
  /** Optional label shown in the rules screen. */
  name?: string;
  enabled: boolean;
  /** Regex matched against the request Host header (without port). */
  hostPattern?: string;
  /** Regex matched against the request URL (path + query). */
  pathPattern?: string;
  destProtocol: Protocol;
  dest: string;
  destPort: number;
}

/** Answers matching requests with a canned response (no upstream contact). */
export interface MockRule {
  id: string;
  /** Optional label shown in the rules screen. */
  name?: string;
  enabled: boolean;
  /** HTTP method, or empty / "*" for any. */
  method?: string;
  /** Regex matched against the request URL (path + query). */
  pathPattern: string;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  /** Artificial latency before responding. */
  delayMs?: number;
}

/** The rules the proxy matches per request; replaceable while it runs. */
export interface RuleSet {
  routes?: RouteRule[];
  mocks?: MockRule[];
}

/** The interceptor scripts and their switches; applied to a running proxy live. */
export type ScriptSet = Pick<
  ProxySettings,
  'requestInterceptor' | 'interceptRequest' | 'responseInterceptor' | 'interceptResponse'
>;

export type ScriptKind = 'request' | 'response';

/** A request as an interceptor script sees it, with the body as text. */
export interface ScriptTrialRequest {
  method: string;
  path: string;
  host: string;
  port: number;
  headers: Headers;
  body: string;
}

/** A response as an interceptor script sees it, with the body as text. */
export interface ScriptTrialResponse {
  statusCode: number;
  headers: Headers;
  body: string;
}

export interface ScriptTrialExchange {
  request: ScriptTrialRequest;
  /** Present for response scripts. */
  response?: ScriptTrialResponse;
}

/** A dry run of a script: nothing is sent anywhere. */
export interface ScriptTrialInput extends ScriptTrialExchange {
  kind: ScriptKind;
  code: string;
}

/** The exchange after the script ran, plus what the script reported. */
export interface ScriptTrialResult extends ScriptTrialExchange {
  error?: string;
  logs: string[];
}

/** Parameters of the upstream request; mutated by request interceptors. */
export interface RequestParams {
  /** Upstream protocol. Defaults to the destination (or matched route) protocol. */
  protocol?: Protocol;
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
  /**
   * The request line and headers as the client sent them, kept when a request
   * script ran, so the script can be tried again on what it originally saw.
   */
  beforeScript?: { url: string; method: string; headers: Headers };
  /** True when the stored body was cut at the display cap. */
  truncated?: boolean;
  /** Full body size in bytes (the stored body may be truncated). */
  size?: number;
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
  /** Body bytes as sent on the wire (before display decompression). */
  size?: number;
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
  /** True while the exchange is still in flight (waiting, streaming, or an open WebSocket). */
  pending?: boolean;
  /** True when a mock rule answered and no upstream was contacted. */
  mocked?: boolean;
  /** True when the client went away before the response completed. */
  clientAborted?: boolean;
  /** True when the entry was loaded from a HAR file rather than captured. */
  imported?: boolean;
  /** Errors thrown (or timeouts hit) by user interceptor code for this exchange. */
  interceptorErrors?: InterceptorIssue[];
  /** console.* output of user interceptor code for this exchange. */
  interceptorLogs?: string[];
  /** Present when the request upgraded to a WebSocket. */
  ws?: WebSocketView;
}

export interface InterceptorIssue {
  phase: 'request' | 'response';
  message: string;
}

export type WsOpcode = 'text' | 'binary' | 'close' | 'ping' | 'pong';

/** One WebSocket message (fragments are reassembled before capture). */
export interface WsMessage {
  /** Who sent it. */
  from: 'client' | 'server';
  opcode: WsOpcode;
  /** Text payload (text frames, close reasons); binary payloads are summarized by size. */
  text?: string;
  /** Payload size in bytes on the wire. */
  size: number;
  /** Milliseconds since the upgrade completed. */
  atMs: number;
  /** True when the captured text was cut at the per-message cap. */
  truncated?: boolean;
  /** Close status code (close frames). */
  closeCode?: number;
}

export interface WebSocketView {
  messages: WsMessage[];
  /** Messages seen in total; exceeds messages.length once the capture cap is hit. */
  messageCount: number;
  /** True once either side closed the connection. */
  closed?: boolean;
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

export type BreakpointPhase = 'request' | 'response';

export interface BreakpointRule {
  id: string;
  /** Regex source matched against the request URL. */
  path: string;
  methods: string[];
  /**
   * 'request' (default) holds the request before it is forwarded; 'response'
   * holds the upstream response before it reaches the client.
   */
  phase?: BreakpointPhase;
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
