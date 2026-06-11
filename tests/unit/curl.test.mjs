// Unit tests for the local curl command builder (src/curl.js).
import { describe, it, expect } from 'vitest';
import { buildCurl } from '../../src/proxy/core/curl';

const curl = { build: buildCurl };

describe('curl builder', () => {
  it('builds a basic GET', () => {
    const cmd = curl.build('http', {
      host: 'example.com',
      port: 8080,
      path: '/api/users',
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    expect(cmd).toBe(
      "curl -X GET 'http://example.com:8080/api/users' -H 'accept: application/json'"
    );
  });

  it('omits default ports', () => {
    expect(curl.build('http', { host: 'h', port: 80, path: '/', method: 'GET' })).toContain(
      "'http://h/'"
    );
    expect(curl.build('https', { host: 'h', port: 443, path: '/', method: 'GET' })).toContain(
      "'https://h/'"
    );
    expect(curl.build('https', { host: 'h', port: 8443, path: '/', method: 'GET' })).toContain(
      "'https://h:8443/'"
    );
  });

  it('includes the request body', () => {
    const cmd = curl.build('http', {
      host: 'h',
      port: 80,
      path: '/post',
      method: 'POST',
      headers: {},
      body: Buffer.from('{"a":1}'),
    });
    expect(cmd).toContain(`--data-binary '{"a":1}'`);
  });

  it('escapes single quotes in headers and body', () => {
    const cmd = curl.build('http', {
      host: 'h',
      port: 80,
      path: '/',
      method: 'POST',
      headers: { 'x-note': "it's quoted" },
      body: Buffer.from("don't break"),
    });
    expect(cmd).toContain(`-H 'x-note: it'\\''s quoted'`);
    expect(cmd).toContain(`--data-binary 'don'\\''t break'`);
  });

  it('repeats -H for array header values', () => {
    const cmd = curl.build('http', {
      host: 'h',
      port: 80,
      path: '/',
      method: 'GET',
      headers: { 'set-cookie': ['a=1', 'b=2'] },
    });
    expect(cmd).toContain("-H 'set-cookie: a=1'");
    expect(cmd).toContain("-H 'set-cookie: b=2'");
  });

  it('does not emit --data-binary for empty bodies', () => {
    const cmd = curl.build('http', {
      host: 'h',
      port: 80,
      path: '/',
      method: 'GET',
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(cmd).not.toContain('--data-binary');
  });
});
