// Turns a captured exchange into the starting point of a new mock or route,
// so "make the proxy answer this the same way" is one click from the table.
import { pathPattern } from '../../../shared/rule-patterns';
import type { MockRule, RouteRule, TrafficEntry } from '../../../shared/types';

/** Largest captured body copied into a mock; bigger ones start empty. */
const MAX_SEED_BODY = 256 * 1024;

function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function bodyText(body: Uint8Array | string | undefined): string {
  if (body === undefined) return '';
  if (typeof body === 'string') return body.length <= MAX_SEED_BODY ? body : '';
  if (body.byteLength > MAX_SEED_BODY) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return ''; // binary: nothing sensible to put in a text box
  }
}

/** A mock that replays this entry's response for the same method and path. */
export function mockFromEntry(entry: TrafficEntry): Omit<MockRule, 'id'> {
  const type = entry.response?.headers['content-type'];
  const contentType = Array.isArray(type) ? type[0] : type;
  const path = pathOf(entry.request.url);
  return {
    name: `${entry.request.method} ${path}`.slice(0, 80),
    enabled: true,
    method: entry.request.method.toUpperCase(),
    pathPattern: pathPattern('exact', path),
    statusCode: entry.response?.statusCode ?? 200,
    headers: contentType ? { 'content-type': contentType } : {},
    body: entry.response?.truncated ? '' : bodyText(entry.response?.body),
  };
}

/** A route for this entry's path, with the destination left to fill in. */
export function routeFromEntry(entry: TrafficEntry): Omit<RouteRule, 'id'> {
  return {
    enabled: true,
    pathPattern: pathPattern('prefix', pathOf(entry.request.url)),
    destProtocol: 'http',
    dest: 'localhost',
    destPort: 3000,
  };
}
