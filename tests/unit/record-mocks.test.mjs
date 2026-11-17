// Record and replay (src/shared/record-mocks.ts): captured exchanges become
// mock rules. The pure conversion, the merge into saved mocks, and a round
// trip through the real proxy: capture, record, then replay with the
// upstream gone.
import { describe, it, expect, afterEach } from 'vitest';
import zlib from 'node:zlib';
import { startUpstream, startProxyServer, request, closeAll, makeSettings } from './helpers.mjs';
import {
  recordMocks,
  mergeRecorded,
  recordedHeaders,
  MAX_RECORDED_BODY,
  RECORDED_PREFIX,
} from '../../src/shared/record-mocks';
import { compileRules, matchMock } from '../../src/proxy/core/rules';
import { sanitizeMockRule } from '../../src/shared/settings-schema';

let id = 0;
function entry({
  method = 'GET',
  url = '/',
  status = 200,
  headers = {},
  body,
  response = {},
  ...rest
} = {}) {
  return {
    trafficId: ++id,
    request: { method, url, headers: {} },
    response: {
      statusCode: status,
      headers,
      body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
      ...response,
    },
    timings: { start: new Date().toISOString() },
    ...rest,
  };
}

const reasons = (recording) =>
  Object.fromEntries(recording.skipped.map((s) => [s.reason, s.count]));

describe('recordMocks', () => {
  it('turns an exchange into an exact-path mock with its status, headers and body', () => {
    const { mocks, sources, skipped } = recordMocks([
      entry({
        url: '/api/users',
        status: 201,
        headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
        body: '{"id":1}',
      }),
    ]);
    expect(skipped).toEqual([]);
    expect(mocks).toHaveLength(1);
    expect(mocks[0]).toMatchObject({
      name: `${RECORDED_PREFIX}GET /api/users`,
      enabled: true,
      method: 'GET',
      pathPattern: '^/api/users(?:\\?.*)?$',
      statusCode: 201,
      headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
      body: '{"id":1}',
    });
    expect(mocks[0].bodyEncoding).toBeUndefined();
    expect(sources[mocks[0].id]).toBe(id);
    // What gets saved survives the settings sanitizer unchanged.
    expect(sanitizeMockRule(mocks[0])).toEqual(mocks[0]);
  });

  it('keeps one mock per method and URL, the latest response winning', () => {
    const first = entry({ url: '/flags', body: 'old' });
    const second = entry({ url: '/flags', body: 'new' });
    const post = entry({ method: 'POST', url: '/flags', body: 'posted' });
    // Order of the input does not matter: request ids decide which is newer.
    const recording = recordMocks([second, post, first]);
    expect(recording.mocks.map((m) => [m.method, m.body])).toEqual([
      ['GET', 'new'],
      ['POST', 'posted'],
    ]);
    expect(recording.skipped).toEqual([
      {
        reason: 'same request recorded again later (the latest is kept)',
        count: 1,
        trafficIds: [first.trafficId],
      },
    ]);
  });

  it('matches the recorded query exactly, and puts those mocks before path-only ones', () => {
    const { mocks } = recordMocks([
      entry({ url: '/search', body: 'all' }),
      entry({ url: '/search?q=a.b', body: 'a' }),
    ]);
    expect(mocks.map((m) => m.body)).toEqual(['a', 'all']);
    const rules = compileRules({ mocks });
    expect(matchMock(rules, 'GET', '/search?q=a.b')?.body).toBe('a');
    // The dot is literal, and another query falls through to the path-only mock.
    expect(matchMock(rules, 'GET', '/search?q=aXb')?.body).toBe('all');
    expect(matchMock(rules, 'GET', '/search?q=a.b&x=1')?.body).toBe('all');
    expect(matchMock(rules, 'GET', '/search')?.body).toBe('all');
    expect(matchMock(rules, 'POST', '/search')).toBeNull();
  });

  it('with ignoreQuery, one mock per path matches any query', () => {
    const { mocks, skipped } = recordMocks(
      [entry({ url: '/search?q=a', body: 'a' }), entry({ url: '/search?q=b', body: 'b' })],
      { ignoreQuery: true }
    );
    expect(mocks).toHaveLength(1);
    expect(mocks[0]).toMatchObject({ name: `${RECORDED_PREFIX}GET /search`, body: 'b' });
    expect(skipped[0].count).toBe(1);
    expect(matchMock(compileRules({ mocks }), 'GET', '/search?anything')?.body).toBe('b');
  });

  it('can save the mocks switched off', () => {
    expect(recordMocks([entry({ url: '/a' })], { enabled: false }).mocks[0].enabled).toBe(false);
  });

  it('keeps binary bodies as base64', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    const [mock] = recordMocks([
      entry({ url: '/logo.png', headers: { 'content-type': 'image/png' }, body: png }),
    ]).mocks;
    expect(mock.bodyEncoding).toBe('base64');
    expect(Buffer.from(mock.body, 'base64')).toEqual(Buffer.from(png));
    expect(sanitizeMockRule(mock)).toEqual(mock);
  });

  it('accepts a string body and an empty body', () => {
    const { mocks } = recordMocks([
      entry({ url: '/text', body: undefined, response: { body: 'plain' } }),
      entry({ method: 'DELETE', url: '/x', status: 204 }),
    ]);
    expect(mocks.map((m) => [m.statusCode, m.body])).toEqual([
      [200, 'plain'],
      [204, ''],
    ]);
  });

  it('skips what cannot be replayed, and says why', () => {
    const recording = recordMocks([
      entry({ url: '/pending', pending: true }),
      entry({ url: '/failed', connectorError: 'ECONNREFUSED' }),
      entry({ url: '/mocked', mocked: true }),
      entry({ url: '/ws', status: 101, ws: { messages: [], messageCount: 0 } }),
      entry({ url: '/svc.Echo/Say', grpc: { method: 'svc.Echo/Say' } }),
      entry({ method: 'CONNECT', url: 'example.com:443' }),
      entry({ url: '/none', response: { statusCode: undefined } }),
      entry({ url: '/cached', status: 304 }),
      entry({ url: '/cut', body: 'part', response: { truncated: true } }),
      entry({ url: '/lost', response: { size: 10 } }),
      entry({ url: '/huge', body: new Uint8Array(MAX_RECORDED_BODY + 1) }),
      entry({ url: '/ok', body: 'fine' }),
    ]);
    expect(recording.mocks.map((m) => m.body)).toEqual(['fine']);
    expect(reasons(recording)).toEqual({
      'still in flight': 1,
      'failed with no response': 1,
      'already answered by a mock': 1,
      'WebSocket (not replayable as a mock)': 1,
      'gRPC (mocks serve HTTP/1.1 only)': 1,
      'CONNECT tunnel': 1,
      'no response': 1,
      '304 Not Modified (depends on the client cache)': 1,
      'response body not fully captured': 2,
      'response body larger than 512 KB': 1,
    });
  });

  it('stops at the total size budget for one recording', () => {
    const big = () => entry({ url: `/b${id}`, body: new Uint8Array(500 * 1024).fill(65) });
    const recording = recordMocks(Array.from({ length: 20 }, big));
    expect(recording.mocks).toHaveLength(16);
    expect(reasons(recording)).toEqual({ 'over the 8 MB total for one recording': 4 });
  });

  it('lists at most 20 ids per skip reason but counts them all', () => {
    const recording = recordMocks(
      Array.from({ length: 25 }, () => entry({ url: '/p', pending: true }))
    );
    expect(recording.skipped[0].count).toBe(25);
    expect(recording.skipped[0].trafficIds).toHaveLength(20);
  });
});

describe('recordedHeaders', () => {
  it('drops hop-by-hop, length and date headers, and content-encoding for decoded bodies', () => {
    const headers = {
      'Content-Type': 'text/html',
      'content-encoding': 'gzip',
      'content-length': '42',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
      date: 'Mon, 01 Jan 2024 00:00:00 GMT',
      'alt-svc': 'h3=":443"',
      vary: ['accept', 'origin'],
      'set-cookie': ['a=1', 'b=2'],
      'cache-control': 'no-cache',
      'x-empty': [],
      'x-undefined': undefined,
    };
    expect(recordedHeaders(entry({ headers }))).toEqual({
      'content-type': 'text/html',
      vary: 'accept, origin',
      'set-cookie': 'a=1',
      'cache-control': 'no-cache',
    });
  });

  it('keeps content-encoding when the body could not be decoded (it is still compressed)', () => {
    const headers = { 'content-encoding': 'br' };
    expect(recordedHeaders(entry({ headers, response: { decodeError: 'bad brotli' } }))).toEqual({
      'content-encoding': 'br',
    });
  });
});

describe('mergeRecorded', () => {
  const saved = (over) => ({
    id: 'saved',
    enabled: true,
    pathPattern: '^/a(?:\\?.*)?$',
    method: 'GET',
    statusCode: 200,
    headers: {},
    body: 'hand-written',
    ...over,
  });

  it('updates a saved mock for the same request in place and appends the rest', () => {
    const recording = recordMocks([
      entry({ url: '/b', body: 'b' }),
      entry({ url: '/a', body: 'a' }),
    ]);
    const other = saved({ id: 'other', pathPattern: '^/z', method: undefined });
    const result = mergeRecorded([saved(), other], recording);
    expect(result.mocks.map((m) => [m.id === 'saved' ? 'saved' : m.id, m.body])).toEqual([
      ['saved', 'a'],
      ['other', 'hand-written'],
      [recording.mocks[0].id, 'b'],
    ]);
    expect(result).toMatchObject({ added: 1, replaced: 1, overLimit: 0 });
    expect(result.stored.map((s) => s.rule.body)).toEqual(['a', 'b']);
    expect(result.stored[0].rule.id).toBe('saved');
  });

  it('a mock for any method is not the same request as a GET mock', () => {
    const recording = recordMocks([entry({ url: '/a', body: 'a' })]);
    const result = mergeRecorded([saved({ method: undefined })], recording);
    expect(result).toMatchObject({ added: 1, replaced: 0 });
  });

  it('stops at the rule limit and reports what did not fit', () => {
    const full = Array.from({ length: 199 }, (_, i) =>
      saved({ id: `s${i}`, pathPattern: `^/s${i}` })
    );
    const recording = recordMocks([
      entry({ url: '/x' }),
      entry({ url: '/y' }),
      entry({ url: '/z' }),
    ]);
    const result = mergeRecorded(full, recording);
    expect(result.mocks).toHaveLength(200);
    expect(result).toMatchObject({ added: 1, overLimit: 2 });
    expect(result.stored).toHaveLength(1);
  });
});

describe('record, then replay with the upstream gone', () => {
  let servers = [];
  afterEach(async () => {
    await closeAll(...servers);
    servers = [];
  });

  it('serves the recorded responses byte for byte, gzip and binary included', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xfe, 0xff]);
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/api/users?page=2') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync('{"page":2}'));
      } else if (req.url === '/logo.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' });
        res.end(png);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain', 'x-why': 'unknown' });
        res.end('not here');
      }
    });
    const recorder = await startProxyServer(makeSettings(upstream.port));
    servers.push(upstream.server, recorder.server);

    const captured = [];
    for (const path of ['/api/users?page=2', '/logo.png', '/missing']) {
      const next = recorder.nextTraffic();
      await request({ port: recorder.port, path });
      captured.push(await next);
    }
    const { mocks, skipped } = recordMocks(captured);
    expect(skipped).toEqual([]);
    await closeAll(upstream.server);

    const replayer = await startProxyServer(makeSettings(upstream.port, { mocks }));
    servers.push(replayer.server);

    const users = await request({ port: replayer.port, path: '/api/users?page=2' });
    expect(users.statusCode).toBe(200);
    // Served decompressed, so no content-encoding and a matching length.
    expect(users.headers['content-encoding']).toBeUndefined();
    expect(users.headers['content-length']).toBe('10');
    expect(users.body.toString()).toBe('{"page":2}');

    const logo = await request({ port: replayer.port, path: '/logo.png' });
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['cache-control']).toBe('max-age=60');
    expect(logo.body).toEqual(png);

    const missing = await request({ port: replayer.port, path: '/missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['x-why']).toBe('unknown');
    expect(missing.body.toString()).toBe('not here');

    // A query the recording never saw is not answered from it.
    const next = replayer.nextTraffic();
    await request({ port: replayer.port, path: '/api/users?page=3' });
    expect((await next).mocked).toBeFalsy();
  });
});
