// Filtering and summarizing captured traffic. Pure and platform-neutral so the
// MCP search_traffic/summarize_session tools and the GUI share exact semantics.
// No Electron, no node:* imports.
import type { Headers, TrafficEntry } from './types';

export interface TrafficFilter {
  /** Free-text substring across method, URL, status, and content-type. */
  text?: string;
  /** HTTP method, case-insensitive exact match. */
  method?: string;
  /** Exact (200), class ("2xx"/"4xx"), or comparison (">=400", "<300", ">300"). */
  status?: string | number;
  urlContains?: string;
  urlRegex?: string;
  /** Substring match on the response content-type. */
  contentType?: string;
  /** "key" (header present) or "key:value" (value contains), across req + res headers. */
  header?: string;
  /** Substring in the request or response body (decoded text). */
  bodyContains?: string;
  /** Only requests at least this slow (total time, ms). */
  minTotalMs?: number;
  /** Only failures: a connector error or a >= 400 status. */
  hasError?: boolean;
}

function bodyText(body: Uint8Array | string | undefined): string {
  if (!body) return '';
  // TextDecoder works in both Node and the renderer (Buffer does not exist in
  // the browser build, and this module is imported by the renderer GUI).
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

function headerValue(headers: Headers, key: string): string | undefined {
  const lower = key.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      return Array.isArray(v) ? v.join(', ') : v;
    }
  }
  return undefined;
}

function contentTypeOf(entry: TrafficEntry): string {
  return headerValue(entry.response.headers, 'content-type') ?? '';
}

function statusMatches(code: number | undefined, spec: string | number): boolean {
  if (code === undefined) return false;
  if (typeof spec === 'number') return code === spec;
  const s = spec.trim().toLowerCase();
  if (/^[1-5]xx$/.test(s)) return Math.floor(code / 100) === Number(s[0]);
  const cmp = s.match(/^(>=|<=|>|<|=)?\s*(\d{3})$/);
  if (cmp) {
    const n = Number(cmp[2]);
    switch (cmp[1]) {
      case '>=': return code >= n;
      case '<=': return code <= n;
      case '>': return code > n;
      case '<': return code < n;
      default: return code === n;
    }
  }
  return false;
}

function headerMatches(entry: TrafficEntry, spec: string): boolean {
  const [key, ...rest] = spec.split(':');
  const wanted = rest.join(':').trim();
  for (const headers of [entry.request.headers, entry.response.headers]) {
    const value = headerValue(headers, key.trim());
    if (value === undefined) continue;
    if (!wanted) return true; // presence
    if (value.toLowerCase().includes(wanted.toLowerCase())) return true;
  }
  return false;
}

function matchesFilter(entry: TrafficEntry, f: TrafficFilter): boolean {
  const status = entry.response.statusCode;

  if (f.method && entry.request.method.toLowerCase() !== f.method.toLowerCase()) return false;
  if (f.status !== undefined && !statusMatches(status, f.status)) return false;
  if (f.urlContains && !entry.request.url.toLowerCase().includes(f.urlContains.toLowerCase())) return false;
  if (f.urlRegex) {
    try {
      if (!new RegExp(f.urlRegex).test(entry.request.url)) return false;
    } catch {
      return false; // an invalid regex matches nothing rather than throwing
    }
  }
  if (f.contentType && !contentTypeOf(entry).toLowerCase().includes(f.contentType.toLowerCase())) return false;
  if (f.header && !headerMatches(entry, f.header)) return false;
  if (f.bodyContains) {
    const needle = f.bodyContains.toLowerCase();
    const hay = (bodyText(entry.request.body) + '\n' + bodyText(entry.response.body)).toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (f.minTotalMs !== undefined) {
    const ms = entry.timings.total !== undefined ? entry.timings.total / 1_000_000 : 0;
    if (ms < f.minTotalMs) return false;
  }
  if (f.hasError !== undefined) {
    const isError = Boolean(entry.connectorError) || (status !== undefined && status >= 400);
    if (f.hasError !== isError) return false;
  }
  if (f.text) {
    const t = f.text.toLowerCase();
    const hay = [entry.request.method, entry.request.url, String(status ?? ''), contentTypeOf(entry)]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(t)) return false;
  }
  return true;
}

export function filterTraffic(entries: TrafficEntry[], filter: TrafficFilter): TrafficEntry[] {
  return entries.filter((e) => matchesFilter(e, filter));
}

export interface TrafficSummary {
  total: number;
  byStatusClass: Record<string, number>;
  byMethod: Record<string, number>;
  contentTypes: Record<string, number>;
  hosts: Array<{ host: string; count: number }>;
  errors: Array<{ trafficId: number; method: string; url: string; status?: number; error?: string }>;
  slowest: Array<{ trafficId: number; method: string; url: string; totalMs: number }>;
}

function totalMs(entry: TrafficEntry): number {
  return entry.timings.total !== undefined ? entry.timings.total / 1_000_000 : 0;
}

function hostOf(entry: TrafficEntry): string {
  if (entry.request.target?.host) return entry.request.target.host;
  return headerValue(entry.request.headers, 'host') ?? '(unknown)';
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Aggregate view of a traffic session — context compression for agents and the GUI. */
export function summarizeTraffic(entries: TrafficEntry[], slowestN = 5): TrafficSummary {
  const byStatusClass: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  const contentTypes: Record<string, number> = {};
  const hostCounts: Record<string, number> = {};
  const errors: TrafficSummary['errors'] = [];

  for (const e of entries) {
    bump(byMethod, e.request.method);
    bump(hostCounts, hostOf(e));
    const ct = contentTypeOf(e).split(';')[0].trim();
    if (ct) bump(contentTypes, ct);

    const status = e.response.statusCode;
    if (e.connectorError) {
      bump(byStatusClass, 'error');
    } else if (status !== undefined) {
      bump(byStatusClass, `${Math.floor(status / 100)}xx`);
    }
    if (e.connectorError || (status !== undefined && status >= 400)) {
      errors.push({
        trafficId: e.trafficId,
        method: e.request.method,
        url: e.request.url,
        status,
        error: e.connectorError ? String(e.connectorError) : undefined,
      });
    }
  }

  const slowest = [...entries]
    .sort((a, b) => totalMs(b) - totalMs(a))
    .slice(0, slowestN)
    .map((e) => ({
      trafficId: e.trafficId,
      method: e.request.method,
      url: e.request.url,
      totalMs: Number(totalMs(e).toFixed(1)),
    }));

  const hosts = Object.entries(hostCounts)
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count);

  return { total: entries.length, byStatusClass, byMethod, contentTypes, hosts, errors, slowest };
}
