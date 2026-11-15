// Helpers for dry-running an interceptor script against a captured exchange:
// building the script's view of the exchange, and describing what it changed.
import type { Headers, ProxySettings, ScriptTrialExchange, TrafficEntry } from './types';

function bodyText(body: Uint8Array | string | undefined): string {
  if (!body) return '';
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

/**
 * A live script gets the body decompressed and no content-encoding header.
 * The captured body is already decompressed, so only the header has to go.
 */
function responseHeaders(entry: TrafficEntry): Headers {
  const headers = { ...entry.response.headers };
  if (entry.response.decodeError) return headers;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-encoding') delete headers[key];
  }
  return headers;
}

/** The exchange as a script would see it. Bodies are the captured (display) text. */
export function exchangeFromEntry(
  entry: TrafficEntry,
  settings: Pick<ProxySettings, 'dest' | 'destPort'>
): ScriptTrialExchange {
  // What the client sent, not what an earlier script run turned it into.
  const sent = entry.request.beforeScript ?? entry.request;
  return {
    request: {
      method: sent.method,
      path: sent.url,
      host: entry.request.target?.host ?? settings.dest,
      port: entry.request.target?.port ?? settings.destPort,
      headers: { ...sent.headers },
      body: bodyText(entry.request.body),
    },
    response: {
      statusCode: entry.response.statusCode ?? 0,
      headers: responseHeaders(entry),
      body: bodyText(entry.response.body),
    },
  };
}

function show(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

function headerChanges(before: Headers, after: Headers, changes: string[]): void {
  const lower = (h: Headers): Map<string, [string, string]> =>
    new Map(
      Object.entries(h)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k.toLowerCase(), [k, show(v)]])
    );
  const a = lower(before);
  const b = lower(after);
  for (const [key, [name, value]] of b) {
    const old = a.get(key);
    if (!old) changes.push(`header ${name} added: ${value}`);
    else if (old[1] !== value) changes.push(`header ${name}: ${old[1]} → ${value}`);
  }
  for (const [key, [name]] of a) {
    if (!b.has(key)) changes.push(`header ${name} removed`);
  }
}

function fieldChange(label: string, before: unknown, after: unknown, changes: string[]): void {
  if (before !== after) changes.push(`${label}: ${String(before)} → ${String(after)}`);
}

function bodyChange(before: string, after: string, changes: string[]): void {
  if (before === after) return;
  changes.push(
    before.length === after.length
      ? `body changed (${after.length} characters)`
      : `body changed (${before.length} → ${after.length} characters)`
  );
}

/** Plain-language list of what a script changed, in the order a reader expects. */
export function describeTrialChanges(
  before: ScriptTrialExchange,
  after: ScriptTrialExchange
): string[] {
  const changes: string[] = [];
  fieldChange('method', before.request.method, after.request.method, changes);
  fieldChange('path', before.request.path, after.request.path, changes);
  fieldChange('host', before.request.host, after.request.host, changes);
  fieldChange('port', before.request.port, after.request.port, changes);
  headerChanges(before.request.headers, after.request.headers, changes);
  bodyChange(before.request.body, after.request.body, changes);
  if (before.response && after.response) {
    fieldChange('status', before.response.statusCode, after.response.statusCode, changes);
    headerChanges(before.response.headers, after.response.headers, changes);
    bodyChange(before.response.body, after.response.body, changes);
  }
  return changes;
}
