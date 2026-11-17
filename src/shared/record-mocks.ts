// Record and replay: turns captured exchanges into mock rules, so a session
// can be served again with no upstream (a frontend running offline, a test
// against fixed responses). Pure and platform-neutral (no Buffer, no node:*),
// so the window's preview, main's IPC handler and the MCP tool share it.
import { newRuleId } from './rule-input';
import { escapeRegex, pathPattern } from './rule-patterns';
import { MAX_RULES } from './settings-schema';
import type { Headers, MockRule, TrafficEntry } from './types';

/** Largest response body copied into a recorded mock. */
export const MAX_RECORDED_BODY = 512 * 1024;
/** Total body bytes one recording may add, so settings stay a sensible size. */
export const MAX_RECORDING_BYTES = 8 * 1024 * 1024;
/** Prefix of every recorded mock's name, so recordings are easy to spot. */
export const RECORDED_PREFIX = 'Recorded: ';

export interface RecordOptions {
  /**
   * Match any query string instead of the recorded one. Off by default:
   * /search?q=a and /search?q=b become separate mocks.
   */
  ignoreQuery?: boolean;
  /** Recorded mocks start enabled unless this is false. */
  enabled?: boolean;
}

export interface SkipGroup {
  reason: string;
  count: number;
  /** The first few skipped request ids, for reference. */
  trafficIds: number[];
}

export interface Recording {
  /** In match order: query-specific mocks before path-only ones. */
  mocks: MockRule[];
  /** trafficId each mock was recorded from, by mock id. */
  sources: Record<string, number>;
  skipped: SkipGroup[];
}

// Hop-by-hop headers and ones the proxy recomputes for the mock's body.
const DROPPED_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-length',
  'date',
  'alt-svc',
]);

const MAX_SKIP_IDS = 20;

function queryIndex(url: string): number {
  const q = url.indexOf('?');
  return q === -1 ? url.length : q;
}

function bodyBytes(body: Uint8Array | string | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array();
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** UTF-8 text as is; anything else (images, protobuf, still-compressed bytes) as base64. */
function encodeBody(bytes: Uint8Array): Pick<MockRule, 'body' | 'bodyEncoding'> {
  try {
    return { body: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { body: base64(bytes), bodyEncoding: 'base64' };
  }
}

/**
 * Response headers worth replaying. The captured body is the decompressed one
 * (unless decompression failed), so content-encoding goes too; the proxy sets
 * content-length from the mock's body.
 */
export function recordedHeaders(entry: TrafficEntry): Record<string, string> {
  const out: Record<string, string> = {};
  const decoded = !entry.response.decodeError;
  const headers: Headers = entry.response.headers ?? {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined || DROPPED_HEADERS.has(name)) continue;
    if (decoded && name === 'content-encoding') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      // A mock header is a single string; several cookies cannot be joined
      // into one Set-Cookie line, so only the first is kept.
      out[name] = name === 'set-cookie' ? String(value[0]) : value.join(', ');
    } else {
      out[name] = String(value);
    }
  }
  return out;
}

/** Why an entry cannot become a mock, or null when it can. */
export function unrecordableReason(entry: TrafficEntry): string | null {
  const status = entry.response.statusCode;
  if (entry.pending) return 'still in flight';
  if (entry.connectorError) return 'failed with no response';
  if (entry.mocked) return 'already answered by a mock';
  if (entry.ws) return 'WebSocket (not replayable as a mock)';
  if (entry.grpc) return 'gRPC (mocks serve HTTP/1.1 only)';
  if (entry.request.method.toUpperCase() === 'CONNECT') return 'CONNECT tunnel';
  if (status === undefined) return 'no response';
  if (status < 200 || status > 599) return `status ${status} cannot be replayed`;
  if (status === 304) return '304 Not Modified (depends on the client cache)';
  const bytes = bodyBytes(entry.response.body);
  if (entry.response.truncated || (bytes.length === 0 && (entry.response.size ?? 0) > 0)) {
    return 'response body not fully captured';
  }
  if (bytes.length > MAX_RECORDED_BODY) return 'response body larger than 512 KB';
  return null;
}

/** The URL part a mock matches: path + query, or the path alone. */
function matchKey(entry: TrafficEntry, ignoreQuery: boolean): string {
  const url = entry.request.url || '/';
  const cut = queryIndex(url);
  return ignoreQuery || cut === url.length ? url.slice(0, cut) : url;
}

function mockPattern(key: string): string {
  // A key with a query matches exactly that URL; a bare path matches any query.
  return key.includes('?') ? `^${escapeRegex(key)}$` : pathPattern('exact', key);
}

/**
 * One mock per method + URL. When a URL was captured several times the most
 * recent response wins: it reflects the server's latest state.
 */
export function recordMocks(entries: TrafficEntry[], options: RecordOptions = {}): Recording {
  const ignoreQuery = options.ignoreQuery === true;
  const skips = new Map<string, SkipGroup>();
  const skip = (entry: TrafficEntry, reason: string): void => {
    const group = skips.get(reason) ?? { reason, count: 0, trafficIds: [] };
    group.count++;
    if (group.trafficIds.length < MAX_SKIP_IDS) group.trafficIds.push(entry.trafficId);
    skips.set(reason, group);
  };

  const latest = new Map<string, TrafficEntry>();
  for (const entry of [...entries].sort((a, b) => a.trafficId - b.trafficId)) {
    const reason = unrecordableReason(entry);
    if (reason) {
      skip(entry, reason);
      continue;
    }
    const key = `${entry.request.method.toUpperCase()} ${matchKey(entry, ignoreQuery)}`;
    const previous = latest.get(key);
    if (previous) skip(previous, 'same request recorded again later (the latest is kept)');
    latest.set(key, entry);
  }

  const specific: MockRule[] = [];
  const general: MockRule[] = [];
  const sources: Record<string, number> = {};
  let budget = MAX_RECORDING_BYTES;
  for (const entry of latest.values()) {
    const bytes = bodyBytes(entry.response.body);
    if (bytes.length > budget) {
      skip(entry, 'over the 8 MB total for one recording');
      continue;
    }
    budget -= bytes.length;
    const method = entry.request.method.toUpperCase();
    const key = matchKey(entry, ignoreQuery);
    const mock: MockRule = {
      id: newRuleId(),
      name: `${RECORDED_PREFIX}${method} ${key}`.slice(0, 120),
      enabled: options.enabled !== false,
      method,
      pathPattern: mockPattern(key),
      statusCode: entry.response.statusCode as number,
      headers: recordedHeaders(entry),
      ...encodeBody(bytes),
    };
    // First match wins: a mock for /search?q=a must come before one for /search.
    (key.includes('?') ? specific : general).push(mock);
    sources[mock.id] = entry.trafficId;
  }
  return { mocks: [...specific, ...general], sources, skipped: [...skips.values()] };
}

export interface StoredMock {
  rule: MockRule;
  /** The captured request it was recorded from. */
  trafficId: number;
}

export interface MergeResult {
  mocks: MockRule[];
  /** The recorded mocks as saved (a replaced one keeps the saved mock's id). */
  stored: StoredMock[];
  added: number;
  /** Existing mocks for the same method and URL, updated in place. */
  replaced: number;
  /** Recorded mocks left out because the rule list is full. */
  overLimit: number;
}

/**
 * Adds recorded mocks to the saved ones. A saved mock for the same method and
 * pattern is updated in place (so recording again refreshes a recording, and
 * keeps its position); the rest go after the saved mocks, so hand-written
 * mocks keep priority.
 */
export function mergeRecorded(existing: MockRule[], recording: Recording): MergeResult {
  const sameRequest = (a: MockRule, b: MockRule): boolean =>
    (a.method ?? '') === (b.method ?? '') && a.pathPattern === b.pathPattern;
  const mocks = existing.slice();
  const stored: StoredMock[] = [];
  const fresh: StoredMock[] = [];
  let replaced = 0;
  for (const rule of recording.mocks) {
    const trafficId = recording.sources[rule.id] as number;
    const index = mocks.findIndex((m) => sameRequest(m, rule));
    if (index >= 0) {
      const updated = { ...rule, id: (mocks[index] as MockRule).id };
      mocks[index] = updated;
      stored.push({ rule: updated, trafficId });
      replaced++;
    } else {
      fresh.push({ rule, trafficId });
    }
  }
  const room = Math.max(0, MAX_RULES - mocks.length);
  const kept = fresh.slice(0, room);
  return {
    mocks: [...mocks, ...kept.map((s) => s.rule)],
    stored: [...stored, ...kept],
    added: kept.length,
    replaced,
    overLimit: fresh.length - kept.length,
  };
}
