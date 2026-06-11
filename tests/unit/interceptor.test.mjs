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
    interceptor.interceptResponse(
      responseParams,
      "requestParams.path = '/mutated'",
      requestParams
    );
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
});
