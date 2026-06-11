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

export interface RequestView {
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  curl?: string;
}

export interface ResponseView {
  statusCode?: number;
  headers: Headers;
  /** Decoded for display; the wire body is always passed through unmodified. */
  body?: Uint8Array | string;
  /** Set when displayed-body decompression failed (body falls back to raw bytes). */
  decodeError?: string;
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
