// Tests for the shared JWT/token decoder (used by the GUI and MCP).
import { describe, it, expect } from 'vitest';
import { decodeJwt, findTokens } from '../../src/shared/decode';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function jwt(header, payload) {
  return `${b64url(header)}.${b64url(payload)}.sigsig`;
}

const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;

describe('decodeJwt', () => {
  it('decodes header and claims and parses exp/iat', () => {
    const token = jwt({ alg: 'HS256', typ: 'JWT' }, { sub: 'u1', exp: future, iat: past });
    const d = decodeJwt(token);
    expect(d.header.alg).toBe('HS256');
    expect(d.payload.sub).toBe('u1');
    expect(d.expired).toBe(false);
    expect(d.expiresAt).toMatch(/T/);
    expect(d.issuedAt).toMatch(/T/);
  });

  it('flags an expired token', () => {
    expect(decodeJwt(jwt({ alg: 'none' }, { exp: past })).expired).toBe(true);
  });

  it('returns null for non-JWT strings', () => {
    expect(decodeJwt('not-a-jwt')).toBeNull();
    expect(decodeJwt('only.two')).toBeNull();
    expect(decodeJwt('aaa.bbb.ccc')).toBeNull(); // not valid base64url JSON
  });
});

describe('findTokens', () => {
  it('finds a Bearer JWT in the request Authorization header', () => {
    const token = jwt({ alg: 'HS256' }, { sub: 'abc' });
    const entry = {
      trafficId: 1,
      request: { method: 'GET', url: '/', headers: { authorization: `Bearer ${token}` } },
      response: { headers: {} },
      timings: { start: '' },
    };
    const found = findTokens(entry);
    expect(found).toHaveLength(1);
    expect(found[0].location).toBe('request Authorization');
    expect(found[0].jwt.payload.sub).toBe('abc');
  });

  it('finds JWTs in cookies, ignores non-JWT cookie values', () => {
    const token = jwt({ alg: 'HS256' }, { role: 'admin' });
    const entry = {
      trafficId: 1,
      request: { method: 'GET', url: '/', headers: { cookie: `theme=dark; session=${token}` } },
      response: { headers: {} },
      timings: { start: '' },
    };
    const found = findTokens(entry);
    expect(found).toHaveLength(1);
    expect(found[0].location).toBe('request cookie: session');
    expect(found[0].jwt.payload.role).toBe('admin');
  });

  it('returns nothing when there are no tokens', () => {
    const entry = {
      trafficId: 1,
      request: { method: 'GET', url: '/', headers: { accept: 'application/json' } },
      response: { headers: {} },
      timings: { start: '' },
    };
    expect(findTokens(entry)).toEqual([]);
  });
});
