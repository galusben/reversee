// Dry-running an interceptor script against a captured exchange, and the
// plain-language description of what it changed.
import { describe, it, expect } from 'vitest';
import { tryScript } from '../../src/proxy/core/try-script';
import { describeTrialChanges, exchangeFromEntry } from '../../src/shared/script-trial';

const request = (overrides = {}) => ({
  method: 'POST',
  path: '/api/users?page=1',
  host: 'api.example.com',
  port: 443,
  headers: { 'content-type': 'application/json', cookie: 'a=b' },
  body: '{"name":"x"}',
  ...overrides,
});
const response = (overrides = {}) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"beta":false}',
  ...overrides,
});

describe('tryScript', () => {
  it('returns the request as the script left it, with console output', () => {
    const result = tryScript({
      kind: 'request',
      request: request(),
      code: `
        requestParams.headers['x-debug'] = 'true';
        delete requestParams.headers['cookie'];
        requestParams.path = '/v2' + requestParams.path;
        const data = JSON.parse(requestParams.body.toString());
        data.debug = true;
        requestParams.body = JSON.stringify(data);
        console.log(requestParams.method, data.name);
      `,
    });
    expect(result).toEqual({
      request: {
        method: 'POST',
        path: '/v2/api/users?page=1',
        host: 'api.example.com',
        port: 443,
        headers: { 'content-type': 'application/json', 'x-debug': 'true' },
        body: '{"name":"x","debug":true}',
      },
      error: undefined,
      logs: ['POST x'],
    });
  });

  it('runs a response script with the request readable but not writable', () => {
    const result = tryScript({
      kind: 'response',
      request: request(),
      response: response(),
      code: `
        responseParams.statusCode = requestParams.method === 'POST' ? 503 : 200;
        responseParams.headers['retry-after'] = 5;
        responseParams.body = 'down';
        requestParams.path = '/changed';
      `,
    });
    expect(result.response).toEqual({
      statusCode: 503,
      headers: { 'content-type': 'application/json', 'retry-after': '5' },
      body: 'down',
    });
    expect(result.request.path).toBe('/api/users?page=1');
    expect(result.error).toBeUndefined();
  });

  it('reports a thrown error and keeps what ran before it', () => {
    const result = tryScript({
      kind: 'request',
      request: request(),
      code: "requestParams.method = 'PUT'; console.log('before'); missing();",
    });
    expect(result.error).toBe('missing is not defined');
    expect(result.logs).toEqual(['before']);
    expect(result.request.method).toBe('PUT');
  });

  it('reports syntax errors and cuts off a runaway script', () => {
    expect(tryScript({ kind: 'request', request: request(), code: 'if (' }).error).toMatch(
      /Unexpected/
    );
    const started = Date.now();
    const spin = tryScript({ kind: 'request', request: request(), code: 'while (true) {}' });
    expect(spin.error).toMatch(/timed out after 1000 ms/);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('never mutates its input and tolerates odd values left behind', () => {
    const input = { kind: 'request', request: request(), code: '' };
    const frozen = JSON.stringify(input);
    const result = tryScript({
      ...input,
      code: `
        requestParams.headers = { a: undefined, b: null, c: ['1', 2], d: 7 };
        requestParams.body = null;
        requestParams.port = '8080';
      `,
    });
    expect(JSON.stringify(input)).toBe(frozen);
    expect(result.request.headers).toEqual({ c: ['1', '2'], d: '7' });
    expect(result.request.body).toBe('');
    expect(result.request.port).toBe(8080);
  });

  it('treats a response trial without a response as a request trial', () => {
    const result = tryScript({
      kind: 'response',
      request: request(),
      code: "requestParams.method = 'GET'",
    });
    expect(result.response).toBeUndefined();
    expect(result.request.method).toBe('GET');
  });
});

describe('describeTrialChanges', () => {
  it('lists nothing when nothing changed', () => {
    const exchange = { request: request(), response: response() };
    expect(describeTrialChanges(exchange, structuredClone(exchange))).toEqual([]);
  });

  it('describes request changes in reading order', () => {
    const before = { request: request() };
    const after = {
      request: request({
        method: 'PUT',
        path: '/v2',
        host: 'other',
        port: 8443,
        headers: { 'Content-Type': 'text/plain', 'x-new': ['a', 'b'] },
        body: 'longer body than before',
      }),
    };
    expect(describeTrialChanges(before, after)).toEqual([
      'method: POST → PUT',
      'path: /api/users?page=1 → /v2',
      'host: api.example.com → other',
      'port: 443 → 8443',
      'header Content-Type: application/json → text/plain',
      'header x-new added: a, b',
      'header cookie removed',
      'body changed (12 → 23 characters)',
    ]);
  });

  it('describes response changes, and a same-length body edit', () => {
    const before = { request: request(), response: response() };
    const after = {
      request: request(),
      response: response({ statusCode: 500, headers: {}, body: '{"beta":true }' }),
    };
    expect(describeTrialChanges(before, after)).toEqual([
      'status: 200 → 500',
      'header content-type removed',
      'body changed (14 characters)',
    ]);
  });
});

describe('exchangeFromEntry', () => {
  const entry = (overrides = {}) => ({
    trafficId: 1,
    request: { method: 'GET', url: '/x?y=1', headers: { accept: '*/*' }, body: Buffer.from('in') },
    response: { statusCode: 201, headers: { etag: 'e' }, body: 'out' },
    timings: { start: new Date().toISOString() },
    ...overrides,
  });
  const settings = { dest: 'default.example', destPort: 8443 };

  it('uses where the request was actually sent', () => {
    const e = entry();
    e.request.target = { protocol: 'https', host: 'routed.example', port: 9000 };
    expect(exchangeFromEntry(e, settings)).toEqual({
      request: {
        method: 'GET',
        path: '/x?y=1',
        host: 'routed.example',
        port: 9000,
        headers: { accept: '*/*' },
        body: 'in',
      },
      response: { statusCode: 201, headers: { etag: 'e' }, body: 'out' },
    });
  });

  it('falls back to the destination and to empty bodies', () => {
    const exchange = exchangeFromEntry(
      entry({
        request: { method: 'GET', url: '/', headers: {} },
        response: { headers: {} },
      }),
      settings
    );
    expect(exchange.request).toMatchObject({ host: 'default.example', port: 8443, body: '' });
    expect(exchange.response).toEqual({ statusCode: 0, headers: {}, body: '' });
  });

  it('starts from what the client sent when a request script already ran', () => {
    const e = entry();
    e.request.headers = { accept: '*/*', 'x-debug': 'true' };
    e.request.url = '/rewritten';
    e.request.beforeScript = { url: '/x?y=1', method: 'GET', headers: { accept: '*/*' } };
    expect(exchangeFromEntry(e, settings).request).toMatchObject({
      path: '/x?y=1',
      headers: { accept: '*/*' },
    });
  });

  it('copies headers so a trial cannot touch the captured entry', () => {
    const e = entry();
    exchangeFromEntry(e, settings).request.headers['x'] = '1';
    expect(e.request.headers).toEqual({ accept: '*/*' });
  });
});
