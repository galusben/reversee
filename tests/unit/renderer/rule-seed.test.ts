import { describe, it, expect } from 'vitest';
import { mockFromEntry, routeFromEntry } from '../../../src/renderer/src/lib/rule-seed';
import type { TrafficEntry } from '../../../src/shared/types';

const entry = (request: object, response?: object): TrafficEntry =>
  ({
    trafficId: 1,
    request: { url: '/a/b?x=1#frag', method: 'POST', headers: {}, ...request },
    response: response ? { headers: {}, ...response } : undefined,
  }) as unknown as TrafficEntry;

describe('rule seeds from a captured exchange', () => {
  it('copies status, content type and a text body into a mock', () => {
    expect(
      mockFromEntry(
        entry({}, { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'nope' })
      )
    ).toEqual({
      name: 'POST /a/b',
      enabled: true,
      method: 'POST',
      pathPattern: '^/a/b(?:\\?.*)?$',
      statusCode: 404,
      headers: { 'content-type': 'text/plain' },
      body: 'nope',
    });
  });

  it('leaves the body empty when it is missing, binary, truncated or huge', () => {
    expect(mockFromEntry(entry({ url: '/x' }))).toMatchObject({
      statusCode: 200,
      headers: {},
      body: '',
    });
    const binary = new Uint8Array([0xff, 0xfe, 0x00]);
    expect(mockFromEntry(entry({}, { body: binary })).body).toBe('');
    expect(mockFromEntry(entry({}, { body: 'cut', truncated: true })).body).toBe('');
    expect(mockFromEntry(entry({}, { body: 'x'.repeat(300_000) })).body).toBe('');
    expect(mockFromEntry(entry({}, { body: new Uint8Array(300_000) })).body).toBe('');
    expect(mockFromEntry(entry({}, { body: new TextEncoder().encode('ok') })).body).toBe('ok');
  });

  it('seeds a route on the path prefix', () => {
    expect(routeFromEntry(entry({}))).toEqual({
      enabled: true,
      pathPattern: '^/a/b',
      destProtocol: 'http',
      dest: 'localhost',
      destPort: 3000,
    });
  });
});
