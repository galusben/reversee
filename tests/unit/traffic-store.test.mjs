// Unit tests for the main-process traffic ring buffer.
import { describe, it, expect } from 'vitest';
import { TrafficStore, BODY_DISPLAY_CAP } from '../../src/main/traffic-store';

function entry(overrides = {}) {
  return {
    trafficId: 0, // assigned by the store
    request: { url: '/r', method: 'GET', headers: {} },
    response: { statusCode: 200, headers: {}, body: Buffer.from('ok') },
    timings: { start: new Date() },
    ...overrides,
  };
}

describe('TrafficStore', () => {
  it('assigns fresh monotonic ids and returns entries in order', () => {
    const store = new TrafficStore();
    const a = store.add(entry());
    const b = store.add(entry());
    expect(a.trafficId).toBe(1);
    expect(b.trafficId).toBe(2);
    expect(store.getAll().map((e) => e.trafficId)).toEqual([1, 2]);
  });

  it('overrides any worker-supplied id (immune to restart collisions)', () => {
    const store = new TrafficStore();
    // A restarted proxy worker would reset its own counter to 0 — the store
    // reassigns regardless, so ids are never reused.
    expect(store.add(entry({ trafficId: 0 })).trafficId).toBe(1);
    expect(store.add(entry({ trafficId: 0 })).trafficId).toBe(2);
  });

  it('does not reset ids after clear', () => {
    const store = new TrafficStore();
    store.add(entry());
    store.add(entry());
    store.clear();
    expect(store.add(entry()).trafficId).toBe(3);
  });

  it('evicts the oldest entries beyond the cap', () => {
    const store = new TrafficStore(3);
    for (let i = 0; i < 5; i++) store.add(entry());
    expect(store.getAll().map((e) => e.trafficId)).toEqual([3, 4, 5]);
  });

  it('looks up an entry by its assigned id', () => {
    const store = new TrafficStore();
    store.add(entry());
    const b = store.add(entry({ request: { url: '/two', method: 'POST', headers: {} } }));
    expect(store.get(b.trafficId).request.url).toBe('/two');
    expect(store.get(999)).toBeUndefined();
  });

  it('truncates oversized bodies and flags them', () => {
    const store = new TrafficStore();
    const big = Buffer.alloc(BODY_DISPLAY_CAP + 1000, 120);
    const added = store.add(entry({ response: { headers: {}, body: big } }));
    expect(added.response.body.length).toBe(BODY_DISPLAY_CAP);
    expect(added.response.truncated).toBe(true);
  });

  it('leaves small bodies untouched', () => {
    const store = new TrafficStore();
    const added = store.add(entry());
    expect(added.response.truncated).toBeUndefined();
    expect(added.response.body.toString()).toBe('ok');
  });

  it('clears all entries', () => {
    const store = new TrafficStore();
    store.add(entry());
    store.clear();
    expect(store.size).toBe(0);
  });
});
