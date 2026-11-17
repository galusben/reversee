// Application settings: shape, defaults, and sanitization. Shared by the main
// process settings store, the renderer form, and the MCP update_config tool.
import type { MockRule, Protocol, ProxySettings, RouteRule } from './types';

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface AppSettings {
  listenProtocol: Protocol;
  listenPort: number;
  destProtocol: Protocol;
  dest: string;
  destPort: number;
  interceptRequest: boolean;
  requestInterceptor: string;
  interceptResponse: boolean;
  responseInterceptor: string;
  /** Rewrite absolute 3xx Location headers back to the listen address. */
  rewriteRedirects: boolean;
  /** Rewrite the Host header to the destination. */
  rewriteHost: boolean;
  allowSelfSignedUpstream: boolean;
  /** Expose the local MCP control socket (read-only by default). */
  mcpEnabled: boolean;
  /** Allow MCP clients to start/stop/configure the proxy. */
  mcpAllowControl: boolean;
  /** Run an HTTP/2 listener so native gRPC can be proxied and decoded. */
  enableGrpc: boolean;
  /**
   * "Capture anything": work as a regular HTTP/HTTPS proxy and send each request
   * to the server the client asked for, instead of to one destination.
   */
  captureAll: boolean;
  /**
   * Capture anything only: verify the certificates of the HTTPS servers
   * requests are sent to. On by default, because in that mode the servers are
   * whatever the client talks to, not one development box.
   */
  captureVerifyUpstream: boolean;
  /** Seconds to wait for upstream response headers before a 504 (0 = never). */
  upstreamTimeoutSec: number;
  /** How many captured requests to keep (oldest are evicted). */
  trafficCap: number;
  theme: ThemeSetting;
  /** Per-request destination overrides; first enabled match wins. */
  routes: RouteRule[];
  /** Canned responses served without contacting the upstream. */
  mocks: MockRule[];
  /** Path to a PEM client certificate presented to https upstreams (mutual TLS). */
  upstreamClientCertPath: string;
  /** Path to the PEM private key for upstreamClientCertPath. */
  upstreamClientKeyPath: string;
}

export const TRAFFIC_CAP_MIN = 100;
export const TRAFFIC_CAP_MAX = 20_000;
export const UPSTREAM_TIMEOUT_MAX_SEC = 3600;
export const MAX_RULES = 200;

export const defaultSettings: AppSettings = {
  listenProtocol: 'http',
  listenPort: 8000,
  destProtocol: 'https',
  dest: '',
  destPort: 443,
  interceptRequest: false,
  requestInterceptor:
    '/*Request interceptor. Use javascript. \n' +
    'You can use requestParams object to access the request data. \n' +
    'following attributes are available for manipulation: host, path, method, port, headers and body\n' +
    'Example: \n' +
    "requestParams.headers['custom']='custom val'*/",
  interceptResponse: false,
  responseInterceptor:
    '/*Response interceptor. Use javascript. \n' +
    'You can use responseParams object to access the response data. \n' +
    'currently supported attributes are statusCode, headers and body. Also the requestParams object is available for read \n' +
    'Example: \n' +
    "responseParams.headers['custom']='custom val'*/",
  // The old app's menu checkboxes defaulted to checked.
  rewriteRedirects: true,
  rewriteHost: true,
  allowSelfSignedUpstream: true,
  // The socket is same-user-only and read-only unless control is enabled.
  mcpEnabled: true,
  mcpAllowControl: false,
  // Off by default: only gRPC users need the HTTP/2 listener.
  enableGrpc: false,
  captureAll: false,
  captureVerifyUpstream: true,
  upstreamTimeoutSec: 60,
  trafficCap: 1000,
  theme: 'system',
  routes: [],
  mocks: [],
  upstreamClientCertPath: '',
  upstreamClientKeyPath: '',
};

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isProtocol(value: unknown): value is Protocol {
  return value === 'http' || value === 'https';
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Returns the error message when `source` is not a valid regular expression. */
export function regexError(source: string): string | null {
  try {
    new RegExp(source);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function optionalPattern(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || regexError(value)) return null;
  return value;
}

function ruleName(value: unknown): { name?: string } {
  const name = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  return name ? { name } : {};
}

/** A well-formed route rule, or null when any field is invalid. */
export function sanitizeRouteRule(raw: unknown): RouteRule | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const hostPattern = optionalPattern(r['hostPattern']);
  const pathPattern = optionalPattern(r['pathPattern']);
  if (hostPattern === null || pathPattern === null) return null;
  if (typeof r['id'] !== 'string' || !r['id']) return null;
  if (typeof r['dest'] !== 'string' || !r['dest'].trim()) return null;
  if (!isProtocol(r['destProtocol']) || !isValidPort(r['destPort'])) return null;
  return {
    id: r['id'],
    ...ruleName(r['name']),
    enabled: r['enabled'] !== false,
    ...(hostPattern ? { hostPattern } : {}),
    ...(pathPattern ? { pathPattern } : {}),
    destProtocol: r['destProtocol'],
    dest: r['dest'].trim(),
    destPort: r['destPort'],
  };
}

/** A well-formed mock rule, or null when any field is invalid. */
export function sanitizeMockRule(raw: unknown): MockRule | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !r['id']) return null;
  if (typeof r['pathPattern'] !== 'string' || regexError(r['pathPattern'])) return null;
  if (!isIntInRange(r['statusCode'], 100, 599)) return null;
  const headers: Record<string, string> = {};
  if (typeof r['headers'] === 'object' && r['headers'] !== null) {
    for (const [k, v] of Object.entries(r['headers'] as Record<string, unknown>)) {
      if (k && typeof v === 'string') headers[k] = v;
    }
  }
  const method = typeof r['method'] === 'string' ? r['method'].trim().toUpperCase() : '';
  return {
    id: r['id'],
    ...ruleName(r['name']),
    enabled: r['enabled'] !== false,
    ...(method && method !== '*' ? { method } : {}),
    pathPattern: r['pathPattern'],
    statusCode: r['statusCode'],
    headers,
    body: typeof r['body'] === 'string' ? r['body'] : '',
    ...(r['bodyEncoding'] === 'base64' ? { bodyEncoding: 'base64' as const } : {}),
    ...(isIntInRange(r['delayMs'], 1, 600_000) ? { delayMs: r['delayMs'] } : {}),
  };
}

function sanitizeList<T>(raw: unknown, one: (item: unknown) => T | null): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: T[] = [];
  for (const item of raw.slice(0, MAX_RULES)) {
    const rule = one(item);
    if (rule) out.push(rule);
  }
  return out;
}

/**
 * Returns only the keys of `patch` that are valid AppSettings fields with
 * valid values. Unknown keys and invalid values are dropped.
 */
export function sanitizeSettingsPatch(patch: unknown): Partial<AppSettings> {
  if (typeof patch !== 'object' || patch === null) return {};
  const p = patch as Record<string, unknown>;
  const out: Partial<AppSettings> = {};

  if (isProtocol(p['listenProtocol'])) out.listenProtocol = p['listenProtocol'];
  if (isProtocol(p['destProtocol'])) out.destProtocol = p['destProtocol'];
  if (isValidPort(p['listenPort'])) out.listenPort = p['listenPort'];
  if (isValidPort(p['destPort'])) out.destPort = p['destPort'];
  if (typeof p['dest'] === 'string') out.dest = p['dest'];
  for (const key of [
    'interceptRequest',
    'interceptResponse',
    'rewriteRedirects',
    'rewriteHost',
    'allowSelfSignedUpstream',
    'mcpEnabled',
    'mcpAllowControl',
    'enableGrpc',
    'captureAll',
    'captureVerifyUpstream',
  ] as const) {
    if (typeof p[key] === 'boolean') out[key] = p[key];
  }
  for (const key of [
    'requestInterceptor',
    'responseInterceptor',
    'upstreamClientCertPath',
    'upstreamClientKeyPath',
  ] as const) {
    if (typeof p[key] === 'string') out[key] = p[key];
  }
  if (isIntInRange(p['upstreamTimeoutSec'], 0, UPSTREAM_TIMEOUT_MAX_SEC)) {
    out.upstreamTimeoutSec = p['upstreamTimeoutSec'];
  }
  if (isIntInRange(p['trafficCap'], TRAFFIC_CAP_MIN, TRAFFIC_CAP_MAX)) {
    out.trafficCap = p['trafficCap'];
  }
  if (p['theme'] === 'system' || p['theme'] === 'light' || p['theme'] === 'dark') {
    out.theme = p['theme'];
  }
  const routes = sanitizeList(p['routes'], sanitizeRouteRule);
  if (routes) out.routes = routes;
  const mocks = sanitizeList(p['mocks'], sanitizeMockRule);
  if (mocks) out.mocks = mocks;
  return out;
}

/** Whether upstream TLS certificates are verified in the current mode. */
export function verifiesUpstream(s: AppSettings): boolean {
  return s.captureAll ? s.captureVerifyUpstream : !s.allowSelfSignedUpstream;
}

/**
 * Maps stored app settings to the proxy core's settings shape. The client
 * certificate is passed in already read from disk (main owns file access).
 */
export function toProxySettings(
  s: AppSettings,
  upstreamClientCert?: { cert: string; key: string }
): ProxySettings {
  return {
    dest: s.dest,
    destProtocol: s.destProtocol,
    destPort: s.destPort,
    listenPort: s.listenPort,
    // A proxy address is always given to clients as http://; HTTPS travels inside CONNECT.
    listenProtocol: s.captureAll ? 'http' : s.listenProtocol,
    redirect: s.rewriteRedirects,
    hostRewrite: s.rewriteHost,
    allowSelfSignedUpstream: !verifiesUpstream(s),
    requestInterceptor: s.requestInterceptor,
    interceptRequest: s.interceptRequest,
    responseInterceptor: s.responseInterceptor,
    interceptResponse: s.interceptResponse,
    // Capture anything needs the HTTP/1.1 proxy listener; gRPC mode is one-server only.
    enableGrpc: s.enableGrpc && !s.captureAll,
    captureAll: s.captureAll,
    upstreamTimeoutSec: s.upstreamTimeoutSec,
    routes: s.routes,
    mocks: s.mocks,
    ...(upstreamClientCert ? { upstreamClientCert } : {}),
  };
}
