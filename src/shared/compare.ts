// Compares two captured exchanges: request line, status, headers and bodies.
// Pure and browser-safe (no Buffer): shared by the Compare screen and the
// compare_requests MCP tool. Answers "why did this call work and that one fail".
import type { Headers, TrafficEntry } from './types';

export type DiffStatus = 'same' | 'changed' | 'added' | 'removed';

/** One named value on both sides. `added` = only in B, `removed` = only in A. */
export interface FieldDiff {
  name: string;
  a?: string;
  b?: string;
  status: DiffStatus;
}

export type BodyKind = 'empty' | 'json' | 'text' | 'binary';

/** One side's body, normalized for diffing. */
export interface BodySide {
  kind: BodyKind;
  /** Text to diff: pretty-printed JSON (keys sorted), the text, or a binary summary. */
  text: string;
  /** Size of the stored (displayed) body in bytes. */
  bytes: number;
  /** True when the stored body was cut at the capture cap. */
  truncated?: boolean;
}

export interface BodyDiff {
  a: BodySide;
  b: BodySide;
  equal: boolean;
}

export interface ExchangeSide {
  trafficId: number;
  method: string;
  url: string;
  target?: string;
  status?: string;
}

export interface ExchangeComparison {
  a: ExchangeSide;
  b: ExchangeSide;
  /** True when nothing compared (request line, status, headers, bodies) differs. */
  identical: boolean;
  /** Short plain-language list of the differences, most telling first. */
  summary: string[];
  /** method, url, target. */
  requestLine: FieldDiff[];
  status: FieldDiff;
  requestHeaders: FieldDiff[];
  responseHeaders: FieldDiff[];
  requestBody: BodyDiff;
  responseBody: BodyDiff;
}

export interface CompareOptions {
  /** Header names (case-insensitive) left out of the header diffs. */
  ignoreHeaders?: string[];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

/** Diffs two header sets by name (case-insensitive), sorted by name. */
export function diffHeaders(a: Headers, b: Headers, ignore: string[] = []): FieldDiff[] {
  const skip = new Set(ignore.map((h) => h.toLowerCase()));
  const lower = (h: Headers): Map<string, string> => {
    const m = new Map<string, string>();
    for (const key of Object.keys(h)) {
      const v = headerValue(h[key]);
      if (v === undefined) continue;
      const k = key.toLowerCase();
      // Two spellings of one header: keep both values, like a joined list.
      m.set(k, m.has(k) ? `${m.get(k)}, ${v}` : v);
    }
    return m;
  };
  const ma = lower(a);
  const mb = lower(b);
  const names = [...new Set([...ma.keys(), ...mb.keys()])].filter((n) => !skip.has(n)).sort();
  return names.map((name) => field(name, ma.get(name), mb.get(name)));
}

function field(name: string, a: string | undefined, b: string | undefined): FieldDiff {
  const status: DiffStatus =
    a === b ? 'same' : a === undefined ? 'added' : b === undefined ? 'removed' : 'changed';
  return { name, ...(a !== undefined ? { a } : {}), ...(b !== undefined ? { b } : {}), status };
}

function contentTypeOf(headers: Headers): string {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-type') return headerValue(headers[key]) ?? '';
  }
  return '';
}

/** Recursively sorts object keys so two JSON documents diff by meaning, not key order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Text that is mostly control characters (or has NULs) is treated as binary. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) control++;
  }
  return n > 0 && control / n > 0.1;
}

function hex(bytes: Uint8Array, max: number): string {
  let s = '';
  for (let i = 0; i < Math.min(bytes.length, max); i++) {
    s += bytes[i].toString(16).padStart(2, '0') + (i % 16 === 15 ? '\n' : ' ');
  }
  return s.trimEnd();
}

/** Cheap content fingerprint (FNV-1a) so equal binaries can be told apart from different ones. */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Normalizes a stored body for diffing: JSON pretty-printed with sorted keys,
 * text as is, binary as a size + fingerprint + hex preview. */
export function normalizeBody(
  body: Uint8Array | string | undefined,
  contentType = '',
  truncated?: boolean
): BodySide {
  const extra = truncated ? { truncated: true } : {};
  if (body === undefined || body.length === 0)
    return { kind: 'empty', text: '', bytes: 0, ...extra };
  let text: string;
  let bytes: number;
  if (typeof body === 'string') {
    text = body;
    bytes = new TextEncoder().encode(body).length;
  } else {
    bytes = body.length;
    let decoded: string | undefined;
    if (!looksBinary(body)) {
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
      } catch {
        decoded = undefined;
      }
    }
    if (decoded === undefined) {
      return {
        kind: 'binary',
        text: `<binary body: ${bytes} bytes, fnv1a ${fnv1a(body)}>\n${hex(body, 256)}${
          bytes > 256 ? '\n…' : ''
        }`,
        bytes,
        ...extra,
      };
    }
    text = decoded;
  }
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const trimmed = text.trimStart();
  const jsonish =
    mime.endsWith('json') ||
    mime.endsWith('+json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');
  if (jsonish && !truncated) {
    try {
      return {
        kind: 'json',
        text: JSON.stringify(sortKeys(JSON.parse(text)), null, 2),
        bytes,
        ...extra,
      };
    } catch {
      // Not JSON after all; diff it as text.
    }
  }
  return { kind: 'text', text, bytes, ...extra };
}

function sideOf(entry: TrafficEntry): ExchangeSide {
  const t = entry.request.target;
  return {
    trafficId: entry.trafficId,
    method: entry.request.method,
    url: entry.request.url,
    ...(t ? { target: `${t.protocol}://${t.host}:${t.port}` } : {}),
    ...(statusString(entry) !== undefined ? { status: statusString(entry) } : {}),
  };
}

/** The outcome as one string: HTTP status, gRPC status, or the connection error. */
function statusString(entry: TrafficEntry): string | undefined {
  if (entry.connectorError) return `error: ${String(entry.connectorError)}`;
  const parts: string[] = [];
  if (entry.response.statusCode !== undefined) parts.push(String(entry.response.statusCode));
  if (entry.grpc?.status !== undefined) parts.push(`grpc-status ${entry.grpc.status}`);
  if (parts.length === 0) return entry.pending ? 'pending' : undefined;
  return parts.join(' / ');
}

function describeBody(label: string, d: BodyDiff): string | undefined {
  if (d.equal) return undefined;
  if (d.a.kind === 'empty') return `${label}: only B has one (${d.b.bytes} bytes)`;
  if (d.b.kind === 'empty') return `${label}: only A has one (${d.a.bytes} bytes)`;
  return `${label} differs (${d.a.bytes} → ${d.b.bytes} bytes)`;
}

function describeHeaders(label: string, diffs: FieldDiff[]): string[] {
  const out: string[] = [];
  for (const d of diffs) {
    if (d.status === 'changed') out.push(`${label} header ${d.name}: "${d.a}" → "${d.b}"`);
    else if (d.status === 'added') out.push(`${label} header ${d.name} only in B: "${d.b}"`);
    else if (d.status === 'removed') out.push(`${label} header ${d.name} only in A: "${d.a}"`);
  }
  return out;
}

/** Compares exchange A with exchange B. */
export function compareExchanges(
  a: TrafficEntry,
  b: TrafficEntry,
  options: CompareOptions = {}
): ExchangeComparison {
  const sa = sideOf(a);
  const sb = sideOf(b);
  const requestLine = [
    field('method', sa.method, sb.method),
    field('url', sa.url, sb.url),
    field('target', sa.target, sb.target),
  ].filter((f) => f.a !== undefined || f.b !== undefined);
  const status = field('status', sa.status, sb.status);
  const requestHeaders = diffHeaders(a.request.headers, b.request.headers, options.ignoreHeaders);
  const responseHeaders = diffHeaders(
    a.response.headers,
    b.response.headers,
    options.ignoreHeaders
  );
  const body = (
    x: TrafficEntry['request'] | TrafficEntry['response'],
    y: TrafficEntry['request'] | TrafficEntry['response']
  ): BodyDiff => {
    const na = normalizeBody(x.body, contentTypeOf(x.headers), x.truncated);
    const nb = normalizeBody(y.body, contentTypeOf(y.headers), y.truncated);
    return { a: na, b: nb, equal: na.kind === nb.kind && na.text === nb.text };
  };
  const requestBody = body(a.request, b.request);
  const responseBody = body(a.response, b.response);

  const summary: string[] = [];
  if (status.status !== 'same') {
    summary.push(`status: ${status.a ?? '(none)'} → ${status.b ?? '(none)'}`);
  }
  for (const f of requestLine) {
    if (f.status !== 'same') summary.push(`${f.name}: ${f.a ?? '(none)'} → ${f.b ?? '(none)'}`);
  }
  summary.push(...describeHeaders('request', requestHeaders));
  const reqBody = describeBody('request body', requestBody);
  if (reqBody) summary.push(reqBody);
  summary.push(...describeHeaders('response', responseHeaders));
  const resBody = describeBody('response body', responseBody);
  if (resBody) summary.push(resBody);

  return {
    a: sa,
    b: sb,
    identical: summary.length === 0,
    summary,
    requestLine,
    status,
    requestHeaders,
    responseHeaders,
    requestBody,
    responseBody,
  };
}

/** Line-level diff op. */
export interface LineOp {
  op: ' ' | '-' | '+';
  text: string;
}

/** Above this many cells the LCS table is skipped and the middle is shown as replaced. */
const LCS_CELL_LIMIT = 4_000_000;

/** Line diff (LCS after trimming the common prefix and suffix). */
export function diffLines(a: string, b: string): LineOp[] {
  const la = a === '' ? [] : a.split('\n');
  const lb = b === '' ? [] : b.split('\n');
  let start = 0;
  while (start < la.length && start < lb.length && la[start] === lb[start]) start++;
  let endA = la.length;
  let endB = lb.length;
  while (endA > start && endB > start && la[endA - 1] === lb[endB - 1]) {
    endA--;
    endB--;
  }
  const head: LineOp[] = la.slice(0, start).map((text) => ({ op: ' ', text }));
  const tail: LineOp[] = la.slice(endA).map((text) => ({ op: ' ', text }));
  const ma = la.slice(start, endA);
  const mb = lb.slice(start, endB);
  const n = ma.length;
  const m = mb.length;
  const middle: LineOp[] = [];
  if (n * m > LCS_CELL_LIMIT) {
    for (const text of ma) middle.push({ op: '-', text });
    for (const text of mb) middle.push({ op: '+', text });
  } else {
    // lcs[i][j] = LCS length of ma[i..] and mb[j..], stored flat.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          ma[i] === mb[j]
            ? lcs[(i + 1) * w + j + 1] + 1
            : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        middle.push({ op: ' ', text: ma[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        middle.push({ op: '-', text: ma[i++] });
      } else {
        middle.push({ op: '+', text: mb[j++] });
      }
    }
    while (i < n) middle.push({ op: '-', text: ma[i++] });
    while (j < m) middle.push({ op: '+', text: mb[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** Unified-diff text (with `context` lines around each change), capped at `maxLines`. */
export function unifiedDiff(
  a: string,
  b: string,
  context = 3,
  maxLines = 400
): { diff: string; truncated: boolean } {
  const ops = diffLines(a, b);
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.op === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });
  const out: string[] = [];
  let lineA = 1;
  let lineB = 1;
  let truncated = false;
  for (let idx = 0; idx < ops.length;) {
    if (!keep[idx]) {
      if (ops[idx].op !== '+') lineA++;
      if (ops[idx].op !== '-') lineB++;
      idx++;
      continue;
    }
    let end = idx;
    while (end < ops.length && keep[end]) end++;
    const hunk = ops.slice(idx, end);
    const countA = hunk.filter((o) => o.op !== '+').length;
    const countB = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${lineA},${countA} +${lineB},${countB} @@`);
    for (const o of hunk) out.push(`${o.op}${o.text}`);
    lineA += countA;
    lineB += countB;
    idx = end;
    if (out.length > maxLines) {
      truncated = true;
      break;
    }
  }
  if (out.length > maxLines) {
    out.length = maxLines;
    truncated = true;
  }
  return { diff: out.join('\n'), truncated };
}
