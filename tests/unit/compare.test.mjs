// Exchange comparison (src/shared/compare.ts): header, status and body diffs,
// JSON normalization, binary handling, and the line / unified diff.
import { describe, it, expect } from 'vitest';
import {
  compareExchanges,
  diffHeaders,
  diffLines,
  normalizeBody,
  unifiedDiff,
} from '../../src/shared/compare';

const enc = (s) => new TextEncoder().encode(s);

function exchange({
  id = 1,
  method = 'GET',
  url = '/',
  reqHeaders = {},
  reqBody,
  status = 200,
  resHeaders = {},
  resBody,
  ...rest
} = {}) {
  return {
    trafficId: id,
    request: {
      method,
      url,
      headers: reqHeaders,
      body: reqBody,
      target: { protocol: 'http', host: 'api.test', port: 80 },
    },
    response: { statusCode: status, headers: resHeaders, body: resBody },
    timings: { start: '2026-01-01T00:00:00.000Z' },
    ...rest,
  };
}

describe('diffHeaders', () => {
  it('matches names case-insensitively and classifies each one', () => {
    const d = diffHeaders(
      { Accept: 'a', 'X-Old': '1', Cookie: ['a=1', 'b=2'], Same: 'v' },
      { accept: 'b', 'x-new': '2', cookie: 'a=1, b=2', same: 'v' }
    );
    expect(d).toEqual([
      { name: 'accept', a: 'a', b: 'b', status: 'changed' },
      { name: 'cookie', a: 'a=1, b=2', b: 'a=1, b=2', status: 'same' },
      { name: 'same', a: 'v', b: 'v', status: 'same' },
      { name: 'x-new', b: '2', status: 'added' },
      { name: 'x-old', a: '1', status: 'removed' },
    ]);
  });

  it('leaves out ignored headers', () => {
    expect(diffHeaders({ Date: '1', a: 'x' }, { date: '2', a: 'x' }, ['DATE'])).toEqual([
      { name: 'a', a: 'x', b: 'x', status: 'same' },
    ]);
  });
});

describe('normalizeBody', () => {
  it('pretty-prints JSON with sorted keys, so key order does not count', () => {
    const a = normalizeBody(enc('{"b":1,"a":{"d":2,"c":[{"z":1,"y":2}]}}'), 'application/json');
    const b = normalizeBody(enc('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}'), '');
    expect(a.kind).toBe('json');
    expect(b.kind).toBe('json'); // sniffed from the leading brace
    expect(a.text).toBe(b.text);
    expect(a.text.split('\n')[1]).toBe('  "a": {');
  });

  it('keeps invalid or truncated JSON as text', () => {
    expect(normalizeBody(enc('{"a":'), 'application/json').kind).toBe('text');
    const cut = normalizeBody(enc('{"a":1}'), 'application/json', true);
    expect(cut).toMatchObject({ kind: 'text', text: '{"a":1}', truncated: true });
  });

  it('handles empty, string and text bodies', () => {
    expect(normalizeBody(undefined)).toEqual({ kind: 'empty', text: '', bytes: 0 });
    expect(normalizeBody(new Uint8Array())).toMatchObject({ kind: 'empty' });
    expect(normalizeBody('héllo', 'text/plain')).toEqual({ kind: 'text', text: 'héllo', bytes: 6 });
  });

  it('summarizes binary bodies by size, fingerprint and a hex preview', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const side = normalizeBody(png, 'image/png');
    expect(side.kind).toBe('binary');
    expect(side.bytes).toBe(12);
    expect(side.text).toMatch(/^<binary body: 12 bytes, fnv1a [0-9a-f]{8}>\n89 50 4e 47/);
    // Invalid UTF-8 without NULs is binary too.
    expect(normalizeBody(new Uint8Array([0xff, 0xfe, 0x41])).kind).toBe('binary');
    // Different bytes, different fingerprint.
    const other = normalizeBody(new Uint8Array([...png.slice(0, 11), 14]));
    expect(other.text.split('\n')[0]).not.toBe(side.text.split('\n')[0]);
  });
});

describe('compareExchanges', () => {
  it('finds the differences between a working and a failing call', () => {
    const ok = exchange({
      id: 4,
      reqHeaders: { authorization: 'Bearer new', accept: '*/*' },
      resHeaders: { 'content-type': 'application/json' },
      resBody: enc('{"items":[1,2]}'),
    });
    const bad = exchange({
      id: 9,
      reqHeaders: { authorization: 'Bearer old', accept: '*/*' },
      status: 401,
      resHeaders: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      resBody: enc('{"error":"expired"}'),
    });
    const c = compareExchanges(ok, bad);
    expect(c.a).toMatchObject({ trafficId: 4, status: '200', target: 'http://api.test:80' });
    expect(c.b).toMatchObject({ trafficId: 9, status: '401' });
    expect(c.identical).toBe(false);
    expect(c.summary).toEqual([
      'status: 200 → 401',
      'request header authorization: "Bearer new" → "Bearer old"',
      'response header www-authenticate only in B: "Bearer"',
      'response body differs (15 → 19 bytes)',
    ]);
    expect(c.requestLine.every((f) => f.status === 'same')).toBe(true);
    expect(c.requestBody.equal).toBe(true);
    expect(c.responseBody.equal).toBe(false);
    expect(c.responseBody.a.kind).toBe('json');
  });

  it('treats JSON bodies that differ only in key order and spacing as equal', () => {
    const a = exchange({
      reqBody: enc('{"a":1,"b":2}'),
      reqHeaders: { 'content-type': 'application/json' },
    });
    const b = exchange({
      reqBody: enc('{ "b": 2, "a": 1 }'),
      reqHeaders: { 'content-type': 'application/json' },
    });
    const c = compareExchanges(a, b);
    expect(c.requestBody.equal).toBe(true);
    expect(c.identical).toBe(true);
  });

  it('reports the request line, connection errors, gRPC status and one-sided bodies', () => {
    const a = exchange({ method: 'GET', url: '/a', reqBody: enc('x') });
    const b = exchange({
      method: 'POST',
      url: '/b',
      connectorError: 'ECONNREFUSED',
      status: undefined,
    });
    b.request.target = { protocol: 'https', host: 'other.test', port: 443 };
    const c = compareExchanges(a, b);
    expect(c.summary).toEqual([
      'status: 200 → error: ECONNREFUSED',
      'method: GET → POST',
      'url: /a → /b',
      'target: http://api.test:80 → https://other.test:443',
      'request body: only A has one (1 bytes)',
    ]);
    const g = compareExchanges(
      exchange({ grpc: { status: 0 } }),
      exchange({ grpc: { status: 5 } })
    );
    expect(g.status).toMatchObject({ a: '200 / grpc-status 0', b: '200 / grpc-status 5' });
  });

  it('uses the decompressed (displayed) body the store keeps', () => {
    // The traffic store holds the decoded body plus the original content-encoding
    // header; the diff works on what is stored, so gzip vs identity compares by content.
    const a = exchange({ resHeaders: { 'content-encoding': 'gzip' }, resBody: 'hello' });
    const b = exchange({ resBody: enc('hello') });
    const c = compareExchanges(a, b);
    expect(c.responseBody.equal).toBe(true);
    expect(c.summary).toEqual(['response header content-encoding only in A: "gzip"']);
  });

  it('honours ignoreHeaders', () => {
    const a = exchange({ resHeaders: { date: 'Mon', etag: '1' } });
    const b = exchange({ resHeaders: { Date: 'Tue', etag: '1' } });
    expect(compareExchanges(a, b).identical).toBe(false);
    expect(compareExchanges(a, b, { ignoreHeaders: ['date'] }).identical).toBe(true);
  });
});

describe('diffLines / unifiedDiff', () => {
  it('produces a minimal line diff', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'x' },
      { op: ' ', text: 'c' },
    ]);
    expect(diffLines('', 'a')).toEqual([{ op: '+', text: 'a' }]);
    expect(diffLines('a', '')).toEqual([{ op: '-', text: 'a' }]);
    expect(diffLines('same', 'same')).toEqual([{ op: ' ', text: 'same' }]);
  });

  it('writes hunks with context and line numbers', () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const b = a.replace('line 10', 'LINE TEN');
    const { diff, truncated } = unifiedDiff(a, b, 2);
    expect(truncated).toBe(false);
    expect(diff).toBe(
      [
        '@@ -8,5 +8,5 @@',
        ' line 8',
        ' line 9',
        '-line 10',
        '+LINE TEN',
        ' line 11',
        ' line 12',
      ].join('\n')
    );
    expect(unifiedDiff('x', 'x').diff).toBe('');
  });

  it('splits distant changes into separate hunks and caps the output', () => {
    const a = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l5\n', 'L5\n').replace('l40\n', 'L40\n');
    const hunks = unifiedDiff(a, b, 1)
      .diff.split('\n')
      .filter((l) => l.startsWith('@@'));
    expect(hunks).toEqual(['@@ -5,3 +5,3 @@', '@@ -40,3 +40,3 @@']);
    const big = unifiedDiff(a, Array.from({ length: 50 }, (_, i) => `m${i}`).join('\n'), 3, 10);
    expect(big.truncated).toBe(true);
    expect(big.diff.split('\n')).toHaveLength(10);
  });
});
