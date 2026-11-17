// Routes and mocks store regular expressions, but most rules are "path starts
// with /api" or "path is exactly /health". These helpers turn such a simple
// match into the stored regex and recognise it again, so the rules screen and
// the MCP tools can offer plain choices without changing the stored format.

export type PathMatch = 'prefix' | 'exact' | 'contains' | 'regex';
export type HostMatch = 'exact' | 'regex';

export const PATH_MATCHES: readonly PathMatch[] = ['prefix', 'exact', 'contains', 'regex'];
export const HOST_MATCHES: readonly HostMatch[] = ['exact', 'regex'];

/** "Exact" still accepts a query string: /users matches /users?page=2. */
const QUERY_TAIL = '(?:\\?.*)?$';

export function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The literal a fully escaped regex fragment stands for, or null if it is a real regex. */
function unescapeLiteral(fragment: string): string | null {
  let out = '';
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i] as string;
    if (ch === '\\') {
      const next = fragment[i + 1];
      if (next === undefined || !/[.*+?^${}()|[\]\\/]/.test(next)) return null;
      out += next;
      i++;
    } else if (/[.*+?^${}()|[\]]/.test(ch)) {
      return null;
    } else {
      out += ch;
    }
  }
  return out;
}

export function pathPattern(match: PathMatch, value: string): string {
  switch (match) {
    case 'prefix':
      return `^${escapeRegex(value)}`;
    case 'exact':
      return `^${escapeRegex(value)}${QUERY_TAIL}`;
    case 'contains':
      return escapeRegex(value);
    case 'regex':
      return value;
  }
}

/** Reads a stored path regex back as the simplest match that produces it. */
export function describePathPattern(pattern: string): { match: PathMatch; value: string } {
  const regex = { match: 'regex' as const, value: pattern };
  if (!pattern) return { match: 'prefix', value: '' };
  if (pattern.startsWith('^') && pattern.endsWith(QUERY_TAIL)) {
    const literal = unescapeLiteral(pattern.slice(1, -QUERY_TAIL.length));
    return literal === null ? regex : { match: 'exact', value: literal };
  }
  if (pattern.startsWith('^')) {
    const literal = unescapeLiteral(pattern.slice(1));
    return literal === null ? regex : { match: 'prefix', value: literal };
  }
  const literal = unescapeLiteral(pattern);
  return literal === null ? regex : { match: 'contains', value: literal };
}

export function hostPattern(match: HostMatch, value: string): string {
  return match === 'exact' ? `^${escapeRegex(value)}$` : value;
}

export function describeHostPattern(pattern: string): { match: HostMatch; value: string } {
  if (!pattern) return { match: 'exact', value: '' };
  if (pattern.startsWith('^') && pattern.endsWith('$')) {
    const literal = unescapeLiteral(pattern.slice(1, -1));
    if (literal !== null) return { match: 'exact', value: literal };
  }
  return { match: 'regex', value: pattern };
}

/** A sentence fragment for a stored path regex: `starts with "/api"`. */
export function pathPatternLabel(pattern: string): string {
  const { match, value } = describePathPattern(pattern);
  if (!pattern) return 'any path';
  if (match === 'regex' && pattern.startsWith('^') && pattern.endsWith('$')) {
    // A recorded URL with its query: "/search?q=a" and nothing else.
    const literal = unescapeLiteral(pattern.slice(1, -1));
    if (literal !== null) return `URL is exactly "${literal}"`;
  }
  const words = { prefix: 'starts with', exact: 'is', contains: 'contains', regex: 'matches' };
  return `path ${words[match]} ${match === 'regex' ? `/${value}/` : `"${value}"`}`;
}
