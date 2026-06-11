// Unit tests for the main-process traffic ring buffer.
import { describe, it, expect } from 'vitest';
import { TrafficStore, BODY_DISPLAY_CAP } from '../../src/main/traffic-store';

function entry(id, overrides = {}) {
  return {
    trafficId: id,
    request: { url: `/r${id}`, method: 'GET', headers: {} },
    response: { statusCode: 200, headers: {}, body: Buffer.from('ok') },
    timings: { start: new Date() },
    ...overrides,
  };
}

describe('TrafficStore', () => {
  it('stores and returns entries in order', () => {
    const store = new TrafficStore();
    store.add(entry(1));
    store.add(entry(2));
    expect(store.getAll().map((e) => e.trafficId)).toEqual([1, 2]);
  });

  it('evicts the oldest entries beyond the cap', () => {
    const store = new TrafficStore(3);
    for (let i = 0; i < 5; i++) store.add(entry(i));
    expect(store.getAll().map((e) => e.trafficId)).toEqual([2, 3, 4]);
  });

  it('replaces an existing entry with the same trafficId without growing', () => {
    const store = new TrafficStore(3);
    store.add(entry(1));
    store.add(entry(2));
    store.add(entry(1, { response: { statusCode: 502, headers: {} } }));
    expect(store.size).toBe(2);
    expect(store.get(1).response.statusCode).toBe(502);
    expect(store.getAll().map((e) => e.trafficId)).toEqual([1, 2]);
  });

  it('truncates oversized bodies and flags them', () => {
    const store = new TrafficStore();
    const big = Buffer.alloc(BODY_DISPLAY_CAP + 1000, 120);
    const added = store.add(entry(1, { response: { headers: {}, body: big } }));
    expect(added.response.body.length).toBe(BODY_DISPLAY_CAP);
    expect(added.response.truncated).toBe(true);
  });

  it('leaves small bodies untouched', () => {
    const store = new TrafficStore();
    const added = store.add(entry(1));
    expect(added.response.truncated).toBeUndefined();
    expect(added.response.body.toString()).toBe('ok');
  });

  it('clears all entries', () => {
    const store = new TrafficStore();
    store.add(entry(1));
    store.clear();
    expect(store.size).toBe(0);
  });
});
