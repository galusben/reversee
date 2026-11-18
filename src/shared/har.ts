// HAR 1.2 export / import of captured traffic. Pure and platform-neutral (no
// Buffer, no node:*), so the same code serves the menu action, the MCP tool
// and tests. Spec: http://www.softwareishard.com/blog/har-12-spec/
import { timingPhases } from './timings';
import type { Headers, Protocol, TrafficEntry } from './types';

interface HarNameValue {
  name: string;
  value: string;
}

interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: unknown[];
    headers: HarNameValue[];
    queryString: HarNameValue[];
    postData?: { mimeType: string; text: string; encoding?: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: unknown[];
    headers: HarNameValue[];
    content: HarContent;
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: Record<string, number>;
  /** Reversee-specific facts that HAR has no field for. */
  _reversee?: Record<string, unknown>;
}

export interface Har {
  log: {
    version: string;
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

function toBytes(body: Uint8Array | string | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array();
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Text when the bytes are valid UTF-8, base64 otherwise (images, protobuf…). */
function encodeBody(bytes: Uint8Array): { text: string; encoding?: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { text: base64Encode(bytes), encoding: 'base64' };
  }
}

function headerValue(headers: Headers, name: string): string {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) {
      const v = headers[key];
      return Array.isArray(v) ? v.join(', ') : (v ?? '');
    }
  }
  return '';
}

function harHeaders(headers: Headers): HarNameValue[] {
  const out: HarNameValue[] = [];
  for (const name of Object.keys(headers)) {
    const raw = headers[name];
    if (raw === undefined) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) out.push({ name, value: String(value) });
  }
  return out;
}

function absoluteUrl(entry: TrafficEntry): string {
  const path = entry.request.url || '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const target = entry.request.target;
  if (target) {
    const defaultPort = target.protocol === 'https' ? 443 : 80;
    const port = target.port && target.port !== defaultPort ? `:${target.port}` : '';
    return `${target.protocol}://${target.host}${port}${path}`;
  }
  return `http://${headerValue(entry.request.headers, 'host') || 'unknown'}${path}`;
}

function queryString(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function harTimings(entry: TrafficEntry): Record<string, number> {
  const out: Record<string, number> = {
    blocked: -1,
    dns: -1,
    connect: -1,
    ssl: -1,
    send: 0,
    wait: 0,
    receive: 0,
  };
  for (const phase of timingPhases(entry.timings)) {
    const ms = Number(phase.durationMs.toFixed(3));
    if (phase.key === 'dns') out['dns'] = ms;
    else if (phase.key === 'connect') out['connect'] = ms;
    else if (phase.key === 'tls') {
      // HAR's connect includes the TLS handshake; ssl is the part of it that was TLS.
      out['ssl'] = ms;
      out['connect'] = Number(((out['connect'] < 0 ? 0 : out['connect']) + ms).toFixed(3));
    } else if (phase.key === 'wait') out['wait'] = ms;
    else if (phase.key === 'download') out['receive'] = ms;
  }
  return out;
}

function toHarEntry(entry: TrafficEntry): HarEntry {
  const url = absoluteUrl(entry);
  const requestBytes = toBytes(entry.request.body);
  const responseBytes = toBytes(entry.response.body);
  const started =
    entry.timings.start instanceof Date ? entry.timings.start : new Date(entry.timings.start);

  const extra: Record<string, unknown> = { trafficId: entry.trafficId };
  if (entry.connectorError) extra['error'] = String(entry.connectorError);
  if (entry.replay) extra['replay'] = true;
  if (entry.mocked) extra['mocked'] = true;
  if (entry.clientAborted) extra['clientAborted'] = true;
  if (entry.request.truncated || entry.response.truncated) extra['truncated'] = true;
  if (entry.grpc) {
    extra['grpc'] = {
      method: entry.grpc.method,
      status: entry.grpc.status,
      statusMessage: entry.grpc.statusMessage,
      // Totals seen; past the capture cap only the most recent messages are kept.
      requestMessageCount: entry.grpc.requestMessageCount ?? entry.grpc.requestMessages.length,
      responseMessageCount: entry.grpc.responseMessageCount ?? entry.grpc.responseMessages.length,
      requestMessages: entry.grpc.requestMessages.map((m) => m.json ?? null),
      responseMessages: entry.grpc.responseMessages.map((m) => m.json ?? null),
    };
  }
  if (entry.ws) extra['webSocketMessages'] = entry.ws.messages;

  const har: HarEntry = {
    startedDateTime: Number.isNaN(started.getTime())
      ? new Date(0).toISOString()
      : started.toISOString(),
    time: entry.timings.total !== undefined ? Number((entry.timings.total / 1e6).toFixed(3)) : 0,
    request: {
      method: entry.request.method,
      url,
      httpVersion: entry.grpc ? 'HTTP/2' : 'HTTP/1.1',
      cookies: [],
      headers: harHeaders(entry.request.headers),
      queryString: queryString(url),
      headersSize: -1,
      bodySize: entry.request.size ?? requestBytes.length,
    },
    response: {
      status: entry.response.statusCode ?? 0,
      statusText: '',
      httpVersion: entry.grpc ? 'HTTP/2' : 'HTTP/1.1',
      cookies: [],
      headers: harHeaders(entry.response.headers),
      content: {
        size: responseBytes.length,
        mimeType: headerValue(entry.response.headers, 'content-type'),
        ...(responseBytes.length ? encodeBody(responseBytes) : {}),
      },
      redirectURL: headerValue(entry.response.headers, 'location'),
      headersSize: -1,
      bodySize: entry.response.size ?? responseBytes.length,
    },
    cache: {},
    timings: harTimings(entry),
    _reversee: extra,
  };
  if (requestBytes.length) {
    har.request.postData = {
      mimeType: headerValue(entry.request.headers, 'content-type'),
      ...encodeBody(requestBytes),
    };
  }
  return har;
}

export function toHar(entries: TrafficEntry[], appVersion: string): Har {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Reversee', version: appVersion },
      entries: entries.map(toHarEntry),
    },
  };
}

function fromHarHeaders(list: unknown): Headers {
  const headers: Headers = {};
  if (!Array.isArray(list)) return headers;
  for (const item of list) {
    const name = (item as HarNameValue | null)?.name;
    const value = (item as HarNameValue | null)?.value;
    if (typeof name !== 'string' || !name || name.startsWith(':')) continue;
    const key = name.toLowerCase();
    const existing = headers[key];
    if (existing === undefined) headers[key] = String(value ?? '');
    else headers[key] = [...(Array.isArray(existing) ? existing : [existing]), String(value ?? '')];
  }
  return headers;
}

function fromHarBody(content: { text?: unknown; encoding?: unknown } | undefined): Uint8Array {
  if (!content || typeof content.text !== 'string') return new Uint8Array();
  if (content.encoding === 'base64') {
    try {
      return base64Decode(content.text);
    } catch {
      return new Uint8Array();
    }
  }
  return new TextEncoder().encode(content.text);
}

const ns = (ms: unknown): number | undefined =>
  typeof ms === 'number' && ms >= 0 ? Math.round(ms * 1e6) : undefined;

/**
 * Parses a HAR document (ours or a browser's) into traffic entries. Throws
 * when the document is not a HAR log; malformed individual entries are skipped.
 */
export function fromHar(document: unknown): TrafficEntry[] {
  const entries = (document as Har | null)?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('not a HAR file: missing log.entries');

  const out: TrafficEntry[] = [];
  for (const raw of entries) {
    const request = raw?.request;
    const response = raw?.response;
    if (!request || typeof request.url !== 'string' || typeof request.method !== 'string') continue;

    let path = request.url;
    let target: TrafficEntry['request']['target'];
    try {
      const url = new URL(request.url);
      path = url.pathname + url.search;
      const protocol: Protocol = url.protocol === 'https:' ? 'https' : 'http';
      target = {
        protocol,
        host: url.hostname,
        port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80,
      };
    } catch {
      // keep the raw value as the path; no replay target
    }

    const t = (raw.timings ?? {}) as Record<string, unknown>;
    const total = ns(raw.time);
    const receive = ns(t['receive']);
    const requestBody = fromHarBody(request.postData);
    const responseBody = fromHarBody(response?.content);
    const extra = (raw._reversee ?? {}) as Record<string, unknown>;

    out.push({
      trafficId: 0, // assigned by the traffic store
      imported: true,
      request: {
        url: path,
        method: request.method,
        headers: fromHarHeaders(request.headers),
        body: requestBody,
        size: requestBody.length,
        target,
      },
      response: {
        statusCode:
          typeof response?.status === 'number' && response.status > 0 ? response.status : undefined,
        headers: fromHarHeaders(response?.headers),
        body: responseBody,
        size:
          typeof response?.bodySize === 'number' && response.bodySize >= 0
            ? response.bodySize
            : responseBody.length,
      },
      timings: {
        start:
          typeof raw.startedDateTime === 'string' ? raw.startedDateTime : new Date(0).toISOString(),
        total,
        firstByte: total !== undefined && receive !== undefined ? total - receive : undefined,
      },
      ...(typeof extra['error'] === 'string' ? { connectorError: extra['error'] } : {}),
      ...(extra['mocked'] === true ? { mocked: true } : {}),
    });
  }
  return out;
}
