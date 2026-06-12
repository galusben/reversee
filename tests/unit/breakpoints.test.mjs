// Unit tests for breakpoint rule compilation and matching.
import { describe, it, expect } from 'vitest';
import { compileBreakpoints, matchBreakpoint } from '../../src/proxy/core/breakpoints';

const rule = (id, path, methods) => ({ id, path, methods });

describe('breakpoint compilation', () => {
  it('compiles valid rules', () => {
    const { compiled, errors } = compileBreakpoints([rule('a', '/api/.*', ['GET', 'POST'])]);
    expect(errors).toEqual([]);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].regex).toBeInstanceOf(RegExp);
  });

  it('reports invalid regexes instead of throwing', () => {
    const { compiled, errors } = compileBreakpoints([
      rule('bad', '([unclosed', ['GET']),
      rule('good', '/ok', ['GET']),
    ]);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].id).toBe('good');
    expect(errors).toHaveLength(1);
    expect(errors[0].id).toBe('bad');
    expect(errors[0].error).toMatch(/regular expression/i);
  });
});

describe('breakpoint matching', () => {
  const { compiled } = compileBreakpoints([
    rule('api', '/api/.*', ['GET', 'POST']),
    rule('login', '^/login$', ['POST']),
  ]);

  it('matches url and method', () => {
    expect(matchBreakpoint(compiled, '/api/users', 'GET')?.id).toBe('api');
    expect(matchBreakpoint(compiled, '/login', 'POST')?.id).toBe('login');
  });

  it('requires the method to match', () => {
    expect(matchBreakpoint(compiled, '/login', 'GET')).toBeNull();
  });

  it('requires the url to match', () => {
    expect(matchBreakpoint(compiled, '/other', 'GET')).toBeNull();
  });

  it('returns the first matching rule', () => {
    const both = compileBreakpoints([
      rule('first', '/x', ['GET']),
      rule('second', '/x', ['GET']),
    ]).compiled;
    expect(matchBreakpoint(both, '/x', 'GET')?.id).toBe('first');
  });
});
