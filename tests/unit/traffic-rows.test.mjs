// The window's traffic list holds rows (entries without bodies or curl) and
// fetches full entries from main on demand: the row projection, and the mock
// preview main computes for the window now that the window has no bodies.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toTrafficRow } from '../../src/shared/traffic-row';

const backing = new Map();
vi.mock('electron-store', () => ({
  default: class FakeStore {
    get(key) {
      return backing.get(key);
    }
    set(key, value) {
      backing.set(key, structuredClone(value));
    }
    has(key) {
      return backing.has(key);
    }
    delete(key) {
      backing.delete(key);
    }
  },
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/reversee-test' } }));
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));

const { getSettings } = await import('../../src/main/settings');
const { previewRecordedMocks, saveRecordedMocks } = await import('../../src/main/record-mocks');

const entry = (id, overrides = {}) => ({
  trafficId: id,
  tabId: 't1',
  request: {
    url: `/items/${id}`,
    method: 'GET',
    headers: { accept: 'application/json' },
    body: Buffer.from('request body'),
    curl: "curl -X GET 'http://up.test/items'",
    size: 12,
    target: { protocol: 'http', host: 'up.test', port: 80 },
  },
  response: {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(`{"id":${id}}`),
    size: 999,
  },
  timings: { start: new Date(0), total: 1_000_000 },
  ws: { messages: [{ from: 'client', text: 'hi' }], messageCount: 1 },
  ...overrides,
});

describe('toTrafficRow', () => {
  it('drops both bodies and the curl command, keeping everything the list shows', () => {
    const full = entry(1);
    const row = toTrafficRow(full);
    expect(row.request).not.toHaveProperty('body');
    expect(row.request).not.toHaveProperty('curl');
    expect(row.response).not.toHaveProperty('body');
    expect(row).toMatchObject({
      trafficId: 1,
      tabId: 't1',
      request: { url: '/items/1', method: 'GET', size: 12, target: { host: 'up.test' } },
      response: { statusCode: 200, size: 999, headers: { 'content-type': 'application/json' } },
      ws: { messageCount: 1 },
    });
  });

  it('fills a missing size in from the body, for strings and bytes', () => {
    const full = entry(2);
    delete full.request.size;
    delete full.response.size;
    full.response.body = 'héllo';
    const row = toTrafficRow(full);
    expect(row.request.size).toBe(12);
    expect(row.response.size).toBe(6); // bytes, not characters
  });

  it('leaves the stored entry untouched', () => {
    const full = entry(3);
    toTrafficRow(full);
    expect(full.request.body.toString()).toBe('request body');
    expect(full.request.curl).toContain('curl');
    expect(full.response.body.toString()).toBe('{"id":3}');
  });

  it('is much smaller than the entry when bodies are large', () => {
    const full = entry(4);
    full.response.body = Buffer.alloc(1024 * 1024, 'x');
    expect(JSON.stringify(toTrafficRow(full)).length).toBeLessThan(2000);
  });
});

describe('previewRecordedMocks', () => {
  beforeEach(() => backing.clear());
  /** A plain HTTP exchange (a WebSocket is never recorded as a mock). */
  const http = (id, overrides) => {
    const e = entry(id, overrides);
    delete e.ws;
    return e;
  };

  it('reports what saving would do without saving, and leaves mock bodies out', () => {
    const entries = [http(1), http(2), http(3, { pending: true })];
    const preview = previewRecordedMocks(entries, {});
    expect(getSettings().mocks).toEqual([]);
    expect(preview.mocks.every((m) => m.rule.body === '')).toBe(true);

    const saved = saveRecordedMocks(entries, {});
    expect({ ...preview, mocks: preview.mocks.map((m) => m.trafficId) }).toEqual({
      ...saved,
      mocks: saved.mocks.map((m) => m.trafficId),
    });
    expect(getSettings().mocks.map((m) => m.body)).toEqual(['{"id":1}', '{"id":2}']);
  });

  it('counts an existing mock for the same request as an update', () => {
    saveRecordedMocks([http(1)], {});
    const preview = previewRecordedMocks([http(1)], {});
    expect(preview).toMatchObject({ created: 0, replaced: 1 });
  });
});
