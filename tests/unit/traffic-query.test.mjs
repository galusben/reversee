// Tests for the shared traffic filter + summary (used by MCP and the GUI).
import { describe, it, expect } from 'vitest';
import { filterTraffic, summarizeTraffic } from '../../src/shared/traffic-query';

function e(id, o = {}) {
  return {
    trafficId: id,
    request: {
      method: o.method ?? 'GET',
      url: o.url ?? '/',
      headers: o.reqHeaders ?? {},
      body: o.reqBody,
      target: o.target ?? { protocol: 'http', host: o.host ?? 'api.example.com', port: 80 },
    },
    response: {
      statusCode: o.status,
      headers: o.resHeaders ?? (o.contentType ? { 'content-type': o.contentType } : {}),
      body: o.resBody,
    },
    timings: { start: '', total: (o.totalMs ?? 0) * 1_000_000 },
    connectorError: o.error,
  };
}

const sample = [
  e(1, { method: 'GET', url: '/api/users', status: 200, contentType: 'application/json', resBody: '{"ok":true}', totalMs: 12, host: 'api.example.com' }),
  e(2, { method: 'POST', url: '/api/orders', status: 201, contentType: 'application/json', totalMs: 40, host: 'api.example.com' }),
  e(3, { method: 'GET', url: '/missing', status: 404, contentType: 'application/json', totalMs: 5, host: 'api.example.com' }),
  e(4, { method: 'GET', url: '/slow', status: 500, totalMs: 900, host: 'cdn.example.com' }),
  e(5, { method: 'GET', url: '/down', error: 'ECONNREFUSED', host: 'cdn.example.com' }),
];

const ids = (r) => r.map((x) => x.trafficId);

describe('filterTraffic', () => {
  it('filters by method and status class', () => {
    expect(ids(filterTraffic(sample, { method: 'post' }))).toEqual([2]);
    expect(ids(filterTraffic(sample, { status: '2xx' }))).toEqual([1, 2]);
    expect(ids(filterTraffic(sample, { status: '>=400' }))).toEqual([3, 4]);
    expect(ids(filterTraffic(sample, { status: 404 }))).toEqual([3]);
  });

  it('filters by url, content-type, and body', () => {
    expect(ids(filterTraffic(sample, { urlContains: '/api/' }))).toEqual([1, 2]);
    expect(ids(filterTraffic(sample, { urlRegex: '^/api/(users|orders)$' }))).toEqual([1, 2]);
    expect(ids(filterTraffic(sample, { contentType: 'json' }))).toEqual([1, 2, 3]);
    expect(ids(filterTraffic(sample, { bodyContains: 'ok' }))).toEqual([1]);
  });

  it('filters by timing and error', () => {
    expect(ids(filterTraffic(sample, { minTotalMs: 100 }))).toEqual([4]);
    expect(ids(filterTraffic(sample, { hasError: true }))).toEqual([3, 4, 5]);
    expect(ids(filterTraffic(sample, { hasError: false }))).toEqual([1, 2]);
  });

  it('filters by header presence and value', () => {
    const withAuth = [e(9, { reqHeaders: { authorization: 'Bearer abc' } })];
    expect(ids(filterTraffic(withAuth, { header: 'authorization' }))).toEqual([9]);
    expect(ids(filterTraffic(withAuth, { header: 'authorization:Bearer' }))).toEqual([9]);
    expect(ids(filterTraffic(withAuth, { header: 'authorization:Basic' }))).toEqual([]);
  });

  it('free-text matches across method/url/status/content-type', () => {
    expect(ids(filterTraffic(sample, { text: 'orders' }))).toEqual([2]);
    expect(ids(filterTraffic(sample, { text: '404' }))).toEqual([3]);
  });

  it('an invalid regex matches nothing instead of throwing', () => {
    expect(filterTraffic(sample, { urlRegex: '([' })).toEqual([]);
  });
});

describe('summarizeTraffic', () => {
  it('aggregates status classes, methods, hosts, errors, and slowest', () => {
    const s = summarizeTraffic(sample, 2);
    expect(s.total).toBe(5);
    expect(s.byStatusClass).toEqual({ '2xx': 2, '4xx': 1, '5xx': 1, error: 1 });
    expect(s.byMethod).toEqual({ GET: 4, POST: 1 });
    expect(s.hosts).toEqual([
      { host: 'api.example.com', count: 3 },
      { host: 'cdn.example.com', count: 2 },
    ]);
    expect(s.errors.map((x) => x.trafficId)).toEqual([3, 4, 5]);
    expect(s.errors.find((x) => x.trafficId === 5).error).toMatch(/ECONNREFUSED/);
    expect(s.slowest.map((x) => x.trafficId)).toEqual([4, 2]);
    expect(s.slowest[0].totalMs).toBe(900);
  });
});
