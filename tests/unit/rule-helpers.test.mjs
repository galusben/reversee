// Plain-match <-> regex conversion and the friendly rule builders the MCP
// tools use, checked against the real rule matcher.
import { describe, it, expect } from 'vitest';
import {
  pathPattern,
  describePathPattern,
  hostPattern,
  describeHostPattern,
  pathPatternLabel,
  escapeRegex,
} from '../../src/shared/rule-patterns';
import {
  buildMockRule,
  buildRouteRule,
  parseTarget,
  describeMock,
  describeRoute,
} from '../../src/shared/rule-input';
import { compileRules, matchMock, matchRoute } from '../../src/proxy/core/rules';

describe('rule patterns', () => {
  it.each([
    ['prefix', '/api/v2', '^/api/v2'],
    ['exact', '/users', '^/users(?:\\?.*)?$'],
    ['contains', 'a.b', 'a\\.b'],
    ['regex', '^/v[12]/', '^/v[12]/'],
  ])('%s round-trips through the stored regex', (match, value, source) => {
    expect(pathPattern(match, value)).toBe(source);
    expect(describePathPattern(source)).toEqual({ match, value });
  });

  it('escapes regex characters in plain matches and reads them back', () => {
    const value = '/a+b(c)?.json|x[1]{2}^$*\\';
    for (const match of ['prefix', 'exact', 'contains']) {
      const source = pathPattern(match, value);
      expect(describePathPattern(source)).toEqual({ match, value });
      expect(new RegExp(source).test(value)).toBe(true);
    }
    expect(escapeRegex('a.b')).toBe('a\\.b');
  });

  it('exact ignores the query string but not a longer path', () => {
    const re = new RegExp(pathPattern('exact', '/users'));
    expect(re.test('/users')).toBe(true);
    expect(re.test('/users?page=2')).toBe(true);
    expect(re.test('/users/1')).toBe(false);
    expect(re.test('/v1/users')).toBe(false);
  });

  it('falls back to regex for anything that is not a plain literal', () => {
    expect(describePathPattern('^/v[12]/')).toEqual({ match: 'regex', value: '^/v[12]/' });
    expect(describePathPattern('^/a\\d+$')).toEqual({ match: 'regex', value: '^/a\\d+$' });
    expect(describePathPattern('^/a.b')).toEqual({ match: 'regex', value: '^/a.b' });
    expect(describePathPattern('^/a\\')).toEqual({ match: 'regex', value: '^/a\\' });
    expect(describePathPattern('')).toEqual({ match: 'prefix', value: '' });
    // Hand-written patterns with an escaped slash are still plain.
    expect(describePathPattern('^\\/api')).toEqual({ match: 'prefix', value: '/api' });
  });

  it('hosts are exact or regex', () => {
    expect(hostPattern('exact', 'api.example.com')).toBe('^api\\.example\\.com$');
    expect(describeHostPattern('^api\\.example\\.com$')).toEqual({
      match: 'exact',
      value: 'api.example.com',
    });
    expect(hostPattern('regex', '\\.internal$')).toBe('\\.internal$');
    expect(describeHostPattern('\\.internal$')).toEqual({ match: 'regex', value: '\\.internal$' });
    expect(describeHostPattern('^a.b$')).toEqual({ match: 'regex', value: '^a.b$' });
    expect(describeHostPattern('')).toEqual({ match: 'exact', value: '' });
  });

  it('labels patterns in words', () => {
    expect(pathPatternLabel('^/api')).toBe('path starts with "/api"');
    expect(pathPatternLabel(pathPattern('exact', '/x'))).toBe('path is "/x"');
    expect(pathPatternLabel('x')).toBe('path contains "x"');
    expect(pathPatternLabel('^/v[12]')).toBe('path matches /^/v[12]/');
    expect(pathPatternLabel('')).toBe('any path');
  });
});

describe('buildMockRule', () => {
  it('defaults to an exact path, status 200 and a JSON body for objects', () => {
    const rule = buildMockRule({ path: '/api/flags', body: { beta: true } });
    expect(rule).toEqual({
      id: expect.any(String),
      enabled: true,
      pathPattern: '^/api/flags(?:\\?.*)?$',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: '{\n  "beta": true\n}',
    });
    const rules = compileRules({ mocks: [rule] });
    expect(matchMock(rules, 'GET', '/api/flags?u=1')).toBe(rule);
    expect(matchMock(rules, 'GET', '/api/flags/x')).toBeNull();
    expect(describeMock(rule)).toBe('any method, path is "/api/flags" -> 200');
  });

  it('takes every option', () => {
    const rule = buildMockRule({
      name: '  Down  ',
      method: 'post',
      path: '/pay',
      pathMatch: 'prefix',
      status: 503,
      headers: { 'Content-Type': 'text/plain', 'X-N': 1 },
      body: 'down',
      delayMs: 250,
      enabled: false,
    });
    expect(rule).toMatchObject({
      name: 'Down',
      enabled: false,
      method: 'POST',
      pathPattern: '^/pay',
      statusCode: 503,
      headers: { 'content-type': 'text/plain', 'x-n': '1' },
      body: 'down',
      delayMs: 250,
    });
    expect(describeMock(rule)).toBe('POST, path starts with "/pay" -> 503 after 250 ms');
  });

  it('keeps an explicit content type for a JSON body', () => {
    const rule = buildMockRule({
      path: '/x',
      body: [1],
      headers: { 'content-type': 'application/vnd.api+json' },
    });
    expect(rule.headers['content-type']).toBe('application/vnd.api+json');
    expect(buildMockRule({ path: '/x' }).body).toBe('');
    expect(buildMockRule({ path: '/x', body: null }).body).toBe('');
  });

  it.each([
    [{}, /path is required/],
    [{ path: 5 }, /path must be a string/],
    [{ path: '/x', pathMatch: 'glob' }, /pathMatch must be one of/],
    [{ path: '(', pathMatch: 'regex' }, /not a valid regular expression/],
    [{ path: '/x', status: 99 }, /status must be/],
    [{ path: '/x', status: '200' }, /status must be/],
    [{ path: '/x', headers: 'a: b' }, /headers must be an object/],
    [{ path: '/x', delayMs: -1 }, /delayMs must be/],
    [{ path: '/x', delayMs: 1.5 }, /delayMs must be/],
    [{ path: '/x', name: 3 }, /name must be a string/],
  ])('rejects %j', (input, message) => {
    expect(() => buildMockRule(input)).toThrow(message);
  });
});

describe('buildRouteRule', () => {
  it('routes a path prefix to a target URL', () => {
    const rule = buildRouteRule({ path: '/api/v2', target: 'http://localhost:3001' });
    expect(rule).toEqual({
      id: expect.any(String),
      enabled: true,
      pathPattern: '^/api/v2',
      destProtocol: 'http',
      dest: 'localhost',
      destPort: 3001,
    });
    const rules = compileRules({ routes: [rule] });
    expect(matchRoute(rules, 'x', '/api/v2/items')).toBe(rule);
    expect(matchRoute(rules, 'x', '/api/v1/items')).toBeNull();
    expect(describeRoute(rule)).toBe('path starts with "/api/v2" -> http://localhost:3001');
  });

  it('matches on host, alone or with a path', () => {
    const rule = buildRouteRule({
      name: 'Admin',
      host: 'admin.example.com',
      path: '^/v\\d',
      pathMatch: 'regex',
      target: 'https://admin.internal',
      enabled: false,
    });
    expect(rule).toMatchObject({
      name: 'Admin',
      enabled: false,
      hostPattern: '^admin\\.example\\.com$',
      pathPattern: '^/v\\d',
      destProtocol: 'https',
      dest: 'admin.internal',
      destPort: 443,
    });
    expect(describeRoute(rule)).toBe(
      'host matches /^admin\\.example\\.com$/ and path matches /^/v\\d/ -> https://admin.internal:443'
    );
    const hostOnly = buildRouteRule({
      host: '\\.test$',
      hostMatch: 'regex',
      target: 'localhost:9',
    });
    expect(hostOnly.hostPattern).toBe('\\.test$');
    expect(hostOnly.pathPattern).toBeUndefined();
  });

  it('parses targets', () => {
    expect(parseTarget('localhost:3000')).toEqual({
      destProtocol: 'http',
      dest: 'localhost',
      destPort: 3000,
    });
    expect(parseTarget('https://api.example.com/')).toEqual({
      destProtocol: 'https',
      dest: 'api.example.com',
      destPort: 443,
    });
    expect(parseTarget('http://127.0.0.1')).toMatchObject({ destPort: 80 });
    expect(() => parseTarget('ftp://x')).toThrow(/http:\/\/ or https:\/\//);
    expect(() => parseTarget('http://')).toThrow(/not a valid URL/);
    expect(() => parseTarget('http://x/api')).toThrow(/path is kept as sent/);
    expect(() => parseTarget('http://x/?a=1')).toThrow(/path is kept as sent/);
  });

  it.each([
    [{ path: '/x' }, /target is required/],
    [{ target: 'http://x' }, /give path and\/or host/],
    [{ target: 'http://x', host: '(', hostMatch: 'regex' }, /host is not a valid regular/],
    [{ target: 'http://x', host: 'a', hostMatch: 'glob' }, /hostMatch must be one of/],
    [{ target: 'http://x', path: '[', pathMatch: 'regex' }, /path is not a valid regular/],
  ])('rejects %j', (input, message) => {
    expect(() => buildRouteRule(input)).toThrow(message);
  });
});
