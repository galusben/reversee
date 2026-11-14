// Unit tests for the vm-sandboxed user interceptor engine (src/interceptor.js).
import { describe, it, expect } from 'vitest';
import * as interceptor from '../../src/proxy/core/interceptor';

describe('interceptor engine', () => {
  it('request interceptor mutates requestParams', () => {
    const requestParams = { headers: {} };
    interceptor.interceptRequest(requestParams, "requestParams.headers['x'] = 'y'");
    expect(requestParams.headers['x']).toBe('y');
  });

  it('response interceptor mutates responseParams and reads requestParams', () => {
    const requestParams = { path: '/from-request', headers: {} };
    const responseParams = { headers: {}, body: 'original' };
    interceptor.interceptResponse(
      responseParams,
      'responseParams.body = requestParams.path',
      requestParams
    );
    expect(responseParams.body).toBe('/from-request');
  });

  it('response interceptor gets a shallow copy of requestParams', () => {
    const requestParams = { path: '/orig', headers: {} };
    const responseParams = { headers: {} };
    interceptor.interceptResponse(responseParams, "requestParams.path = '/mutated'", requestParams);
    expect(requestParams.path).toBe('/orig');
  });

  it('swallows errors thrown by user code', () => {
    const requestParams = { headers: {} };
    expect(() =>
      interceptor.interceptRequest(requestParams, 'throw new Error("user bug")')
    ).not.toThrow();
  });

  it('swallows syntax errors in user code', () => {
    const requestParams = { headers: {} };
    expect(() =>
      interceptor.interceptRequest(requestParams, 'this is not javascript {{{')
    ).not.toThrow();
  });

  it('returns the error message and still does not throw', () => {
    const result = interceptor.interceptRequest({ headers: {} }, 'throw new Error("user bug")');
    expect(result).toEqual({ error: 'user bug', logs: [] });
    expect(interceptor.interceptRequest({ headers: {} }, '{{{').error).toMatch(/Unexpected/);
    expect(interceptor.interceptRequest({ headers: {} }, '1 + 1')).toEqual({ logs: [] });
  });

  it('captures console output, formatted, including what ran before a throw', () => {
    const result = interceptor.interceptRequest(
      { path: '/p', headers: {} },
      `console.log('path', requestParams.path, 42);
       console.warn({ a: 1 });
       console.error(new Error('e').message);
       const loop = {}; loop.self = loop; console.info(loop);
       throw new Error('after logs');`
    );
    expect(result.logs).toEqual([
      'path /p 42',
      '[warn] {"a":1}',
      '[error] e',
      '[info] [object Object]',
    ]);
    expect(result.error).toBe('after logs');
  });

  it('bounds the amount of console output kept', () => {
    const result = interceptor.interceptRequest(
      { headers: {} },
      "for (let i = 0; i < 500; i++) console.log('x'.repeat(5000))"
    );
    expect(result.logs).toHaveLength(50);
    expect(result.logs[0]).toHaveLength(2000);
  });

  it('stops a runaway script at the time budget', () => {
    const started = Date.now();
    const result = interceptor.interceptRequest({ headers: {} }, 'while (true) {}', undefined, 100);
    expect(result.error).toBe('interceptor timed out after 100 ms');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('the budget also covers promise chains the script starts', () => {
    const result = interceptor.interceptRequest(
      { headers: {} },
      'Promise.resolve().then(() => { while (true) {} })',
      undefined,
      100
    );
    expect(result.error).toMatch(/timed out/);
  });

  it('keeps working after a timeout', () => {
    interceptor.interceptRequest({ headers: {} }, 'while (true) {}', undefined, 50);
    const params = { headers: {} };
    expect(interceptor.interceptRequest(params, "requestParams.headers.ok = '1'")).toEqual({
      logs: [],
    });
    expect(params.headers.ok).toBe('1');
  });
});
