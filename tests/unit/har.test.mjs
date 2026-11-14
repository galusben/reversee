// HAR 1.2 export/import (src/shared/har.ts) and the timing-phase maths it
// shares with the waterfall view (src/shared/timings.ts).
import { describe, it, expect } from 'vitest';
import { toHar, fromHar } from '../../src/shared/har';
import { timingPhases, formatDuration, formatBytes, totalMs } from '../../src/shared/timings';

const ms = (n) => n * 1_000_000;

function entry(overrides = {}) {
  return {
    trafficId: 7,
    request: {
      url: '/api/items?page=2&q=a%20b',
      method: 'POST',
      headers: {
        host: 'localhost:8000',
        'content-type': 'application/json',
        cookie: ['a=1', 'b=2'],
      },
      body: Buffer.from('{"name":"x"}'),
      size: 12,
      target: { protocol: 'https', host: 'api.example.com', port: 443 },
    },
    response: {
      statusCode: 201,
      headers: { 'content-type': 'application/json; charset=utf-8', location: '/api/items/9' },
      body: Buffer.from('{"id":9}'),
      size: 8,
    },
    timings: {
      start: new Date('2026-03-04T05:06:07.000Z'),
      dnsLookup: ms(2),
      tcpConnection: ms(5),
      tlsHandshake: ms(11),
      firstByte: ms(40),
      total: ms(55),
    },
    ...overrides,
  };
}

describe('timingPhases', () => {
  it('turns cumulative marks into consecutive phases that tile the total', () => {
    const phases = timingPhases(entry().timings);
    expect(phases.map((p) => [p.key, p.startMs, p.durationMs])).toEqual([
      ['dns', 0, 2],
      ['connect', 2, 3],
      ['tls', 5, 6],
      ['wait', 11, 29],
      ['download', 40, 15],
    ]);
    expect(phases.reduce((sum, p) => sum + p.durationMs, 0)).toBe(55);
  });

  it('omits connection phases on a reused socket', () => {
    const phases = timingPhases({ start: 'x', firstByte: ms(8), total: ms(10) });
    expect(phases.map((p) => p.key)).toEqual(['wait', 'download']);
    expect(phases[0]).toMatchObject({ startMs: 0, durationMs: 8 });
  });

  it('returns nothing for an exchange with no marks yet', () => {
    expect(timingPhases({ start: 'x' })).toEqual([]);
    expect(totalMs({ start: 'x' })).toBeUndefined();
  });
});

describe('formatting', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(0.84)).toBe('0.8 ms');
    expect(formatDuration(123.4)).toBe('123 ms');
    expect(formatDuration(1240)).toBe('1.24 s');
  });

  it('formats byte counts', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1400)).toBe('1.4 kB');
    expect(formatBytes(2_310_000)).toBe('2.31 MB');
  });
});

describe('toHar', () => {
  it('produces a HAR 1.2 log with absolute URLs, headers, bodies and timings', () => {
    const har = toHar([entry()], '2.3.0');
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'Reversee', version: '2.3.0' });
    const [e] = har.log.entries;
    expect(e.startedDateTime).toBe('2026-03-04T05:06:07.000Z');
    expect(e.time).toBe(55);
    // The URL names the upstream the request was actually sent to (default port elided).
    expect(e.request.url).toBe('https://api.example.com/api/items?page=2&q=a%20b');
    expect(e.request.method).toBe('POST');
    expect(e.request.queryString).toEqual([
      { name: 'page', value: '2' },
      { name: 'q', value: 'a b' },
    ]);
    // Multi-valued headers become one HAR header each.
    expect(e.request.headers.filter((h) => h.name === 'cookie')).toEqual([
      { name: 'cookie', value: 'a=1' },
      { name: 'cookie', value: 'b=2' },
    ]);
    expect(e.request.postData).toEqual({ mimeType: 'application/json', text: '{"name":"x"}' });
    expect(e.response.status).toBe(201);
    expect(e.response.content).toEqual({
      size: 8,
      mimeType: 'application/json; charset=utf-8',
      text: '{"id":9}',
    });
    expect(e.response.redirectURL).toBe('/api/items/9');
    // HAR's connect includes TLS; ssl is the TLS share of it.
    expect(e.timings).toEqual({
      blocked: -1,
      dns: 2,
      connect: 9,
      ssl: 6,
      send: 0,
      wait: 29,
      receive: 15,
    });
    expect(e._reversee).toEqual({ trafficId: 7 });
  });

  it('keeps a non-default port and falls back to the Host header without a target', () => {
    const withPort = entry();
    withPort.request.target = { protocol: 'http', host: '127.0.0.1', port: 3000 };
    const noTarget = entry();
    delete noTarget.request.target;
    const har = toHar([withPort, noTarget], '1');
    expect(har.log.entries[0].request.url).toBe('http://127.0.0.1:3000/api/items?page=2&q=a%20b');
    expect(har.log.entries[1].request.url).toBe('http://localhost:8000/api/items?page=2&q=a%20b');
  });

  it('base64-encodes bodies that are not valid UTF-8', () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x01]);
    const e = entry();
    e.response.body = binary;
    e.response.headers = { 'content-type': 'image/png' };
    const { content } = toHar([e], '1').log.entries[0].response;
    expect(content.encoding).toBe('base64');
    expect(Buffer.from(content.text, 'base64').equals(binary)).toBe(true);
  });

  it('records errors, mocks, gRPC and WebSocket details under _reversee', () => {
    const e = entry({
      connectorError: new Error('ECONNREFUSED'),
      mocked: true,
      ws: {
        messages: [{ from: 'client', opcode: 'text', text: 'hi', size: 2, atMs: 1 }],
        messageCount: 1,
      },
    });
    const extra = toHar([e], '1').log.entries[0]._reversee;
    expect(extra.error).toMatch(/ECONNREFUSED/);
    expect(extra.mocked).toBe(true);
    expect(extra.webSocketMessages).toHaveLength(1);
  });

  it('survives an entry that has no response yet', () => {
    const e = entry({ response: { headers: {} }, timings: { start: 'not a date' } });
    const [h] = toHar([e], '1').log.entries;
    expect(h.response.status).toBe(0);
    expect(h.time).toBe(0);
    expect(h.startedDateTime).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('fromHar', () => {
  it('round-trips an exported entry', () => {
    const original = entry();
    const [back] = fromHar(JSON.parse(JSON.stringify(toHar([original], '1'))));
    expect(back.imported).toBe(true);
    expect(back.trafficId).toBe(0);
    expect(back.request.method).toBe('POST');
    expect(back.request.url).toBe('/api/items?page=2&q=a%20b');
    expect(back.request.target).toEqual({ protocol: 'https', host: 'api.example.com', port: 443 });
    expect(back.request.headers.cookie).toEqual(['a=1', 'b=2']);
    expect(Buffer.from(back.request.body).toString()).toBe('{"name":"x"}');
    expect(back.response.statusCode).toBe(201);
    expect(Buffer.from(back.response.body).toString()).toBe('{"id":9}');
    expect(back.timings.total).toBe(ms(55));
    expect(back.timings.firstByte).toBe(ms(40));
    expect(back.timings.start).toBe('2026-03-04T05:06:07.000Z');
  });

  it('round-trips binary bodies byte for byte', () => {
    const binary = Buffer.from([0xff, 0x00, 0xc3, 0x28]);
    const e = entry();
    e.response.body = binary;
    const [back] = fromHar(toHar([e], '1'));
    expect(Buffer.from(back.response.body).equals(binary)).toBe(true);
  });

  it('reads a browser-style HAR (HTTP/2 pseudo-headers, explicit port)', () => {
    const [e] = fromHar({
      log: {
        entries: [
          {
            startedDateTime: '2026-01-01T00:00:00.000Z',
            time: 12.5,
            request: {
              method: 'GET',
              url: 'http://localhost:3000/x?y=1',
              headers: [
                { name: ':authority', value: 'localhost:3000' },
                { name: 'Accept', value: '*/*' },
              ],
            },
            response: {
              status: 404,
              headers: [{ name: 'Content-Type', value: 'text/plain' }],
              content: { text: 'nope' },
              bodySize: 4,
            },
            timings: { receive: 2.5 },
          },
        ],
      },
    });
    expect(e.request.headers).toEqual({ accept: '*/*' });
    expect(e.request.target).toEqual({ protocol: 'http', host: 'localhost', port: 3000 });
    expect(e.request.url).toBe('/x?y=1');
    expect(e.response.statusCode).toBe(404);
    expect(e.response.size).toBe(4);
    expect(e.timings.firstByte).toBe(ms(10));
  });

  it('skips malformed entries and rejects non-HAR documents', () => {
    expect(fromHar({ log: { entries: [{}, { request: { url: 5 } }, null] } })).toEqual([]);
    expect(() => fromHar({})).toThrow(/not a HAR file/);
    expect(() => fromHar(null)).toThrow(/not a HAR file/);
    expect(() => fromHar([1, 2])).toThrow(/not a HAR file/);
  });
});
