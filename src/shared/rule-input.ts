// Builds route and mock rules from the friendly input the MCP tools accept
// (plain path matches, a target URL, a JSON body) so agents never have to
// hand-write the stored regex form. Throws an Error naming the bad field.
import { isValidPort, regexError, sanitizeMockRule, sanitizeRouteRule } from './settings-schema';
import {
  HOST_MATCHES,
  PATH_MATCHES,
  hostPattern,
  pathPattern,
  pathPatternLabel,
  type HostMatch,
  type PathMatch,
} from './rule-patterns';
import type { MockRule, Protocol, RouteRule } from './types';

export function newRuleId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, dflt: T): T {
  if (value === undefined || value === null) return dflt;
  if (!allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function pathRegex(path: string, match: PathMatch): string {
  const source = pathPattern(match, path);
  const bad = regexError(source);
  if (bad) throw new Error(`path is not a valid regular expression: ${bad}`);
  return source;
}

export interface MockInput {
  name?: unknown;
  method?: unknown;
  path?: unknown;
  pathMatch?: unknown;
  status?: unknown;
  headers?: unknown;
  body?: unknown;
  delayMs?: unknown;
  enabled?: unknown;
}

export function buildMockRule(input: MockInput): MockRule {
  const path = text(input.path, 'path');
  if (!path) throw new Error('path is required, e.g. "/api/flags"');
  const match = oneOf(input.pathMatch, PATH_MATCHES, 'pathMatch', 'exact');
  const status = input.status ?? 200;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('status must be an integer from 100 to 599');
  }
  if (input.headers !== undefined && (typeof input.headers !== 'object' || !input.headers)) {
    throw new Error('headers must be an object of string values');
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((input.headers ?? {}) as Record<string, unknown>)) {
    headers[k.toLowerCase()] = String(v);
  }
  // An object or array body is sent as JSON, with the content type to match.
  let body = '';
  if (typeof input.body === 'string') {
    body = input.body;
  } else if (input.body !== undefined && input.body !== null) {
    body = JSON.stringify(input.body, null, 2);
    headers['content-type'] ??= 'application/json';
  }
  if (input.delayMs !== undefined) {
    const d = input.delayMs;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 600_000) {
      throw new Error('delayMs must be an integer from 0 to 600000');
    }
  }
  const rule = sanitizeMockRule({
    id: newRuleId(),
    name: text(input.name, 'name'),
    enabled: input.enabled !== false,
    method: text(input.method, 'method'),
    pathPattern: pathRegex(path, match),
    statusCode: status,
    headers,
    body,
    delayMs: input.delayMs,
  });
  if (!rule) throw new Error('the mock rule is not valid');
  return rule;
}

export interface RouteInput {
  name?: unknown;
  path?: unknown;
  pathMatch?: unknown;
  host?: unknown;
  hostMatch?: unknown;
  target?: unknown;
  enabled?: unknown;
}

/** "http://localhost:3001" -> protocol, host and port (defaulting to 80/443). */
export function parseTarget(target: string): {
  destProtocol: Protocol;
  dest: string;
  destPort: number;
} {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`);
  } catch {
    throw new Error(`target is not a valid URL: ${target}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('target must start with http:// or https://');
  }
  const destProtocol: Protocol = url.protocol === 'https:' ? 'https' : 'http';
  const destPort = url.port ? Number(url.port) : destProtocol === 'https' ? 443 : 80;
  if (!url.hostname || !isValidPort(destPort)) throw new Error(`target is not valid: ${target}`);
  if (url.pathname !== '/' || url.search) {
    throw new Error('target takes a scheme, host and port only; the request path is kept as sent');
  }
  return { destProtocol, dest: url.hostname, destPort };
}

export function buildRouteRule(input: RouteInput): RouteRule {
  const target = text(input.target, 'target');
  if (!target) throw new Error('target is required, e.g. "http://localhost:3001"');
  const path = text(input.path, 'path');
  const host = text(input.host, 'host');
  if (!path && !host) {
    throw new Error('give path and/or host; a route with neither would capture every request');
  }
  const pathMatch = oneOf(input.pathMatch, PATH_MATCHES, 'pathMatch', 'prefix');
  const hostMatch = oneOf<HostMatch>(input.hostMatch, HOST_MATCHES, 'hostMatch', 'exact');
  const hostSource = host ? hostPattern(hostMatch, host) : undefined;
  if (hostSource && regexError(hostSource)) {
    throw new Error(`host is not a valid regular expression: ${regexError(hostSource)}`);
  }
  const rule = sanitizeRouteRule({
    id: newRuleId(),
    name: text(input.name, 'name'),
    enabled: input.enabled !== false,
    hostPattern: hostSource,
    pathPattern: path ? pathRegex(path, pathMatch) : undefined,
    ...parseTarget(target),
  });
  if (!rule) throw new Error('the route rule is not valid');
  return rule;
}

/** One-line plain-language summaries, used in list_rules. */
export function describeMock(m: MockRule): string {
  const delay = m.delayMs ? ` after ${m.delayMs} ms` : '';
  return `${m.method ?? 'any method'}, ${pathPatternLabel(m.pathPattern)} -> ${m.statusCode}${delay}`;
}

export function describeRoute(r: RouteRule): string {
  const when = [
    r.hostPattern ? `host matches /${r.hostPattern}/` : '',
    r.pathPattern ? pathPatternLabel(r.pathPattern) : '',
  ].filter(Boolean);
  return `${when.join(' and ') || 'every request'} -> ${r.destProtocol}://${r.dest}:${r.destPort}`;
}
