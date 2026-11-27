// @vitest-environment jsdom
// useTrafficEntry: the window's list holds rows only, and the views that show
// bodies fetch the full entry from main — again whenever its row changes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { installFakeApi, resetStores, settle, trafficEntry } from './fake-api';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
import { useTrafficEntry } from '../../../src/renderer/src/lib/use-traffic-entry';

let fake: ReturnType<typeof installFakeApi>;
/** What "main" holds: full entries by id, separate from the store's rows. */
let main: Map<number, ReturnType<typeof trafficEntry>>;

beforeEach(() => {
  resetStores();
  fake = installFakeApi();
  main = new Map();
  fake.api.getTrafficEntry.mockImplementation((id: number) =>
    Promise.resolve(main.get(id) ?? null)
  );
});
afterEach(cleanup);

function put(id: number, body: string, overrides: Record<string, unknown> = {}) {
  const full = trafficEntry({
    trafficId: id,
    response: { statusCode: 200, headers: {}, body: new TextEncoder().encode(body) },
    ...overrides,
  });
  main.set(id, full);
  // The store gets a row: a new object each time, as a traffic event delivers.
  const row = { ...full, response: { ...full.response, body: undefined } };
  const traffic = useProxyStore.getState().traffic.filter((e) => e.trafficId !== id);
  useProxyStore.setState({ traffic: [...traffic, row].sort((a, b) => a.trafficId - b.trafficId) });
}

const text = (e: { response: { body?: unknown } } | undefined) =>
  e ? new TextDecoder().decode(e.response.body as Uint8Array) : undefined;

describe('useTrafficEntry', () => {
  it('fetches the full entry for the id', async () => {
    put(1, 'one');
    const { result } = renderHook(() => useTrafficEntry(1));
    expect(result.current.ready).toBe(false);
    await settle();
    expect(result.current.ready).toBe(true);
    expect(text(result.current.entry)).toBe('one');
    expect(fake.api.getTrafficEntry).toHaveBeenCalledWith(1);
  });

  it('fetches again when the row updates (a pending exchange completing)', async () => {
    put(1, '', { pending: true });
    const { result } = renderHook(() => useTrafficEntry(1));
    await settle();
    expect(result.current.entry?.pending).toBe(true);

    act(() => put(1, 'done'));
    expect(result.current.ready).toBe(false); // the shown entry is now behind its row
    await settle();
    expect(result.current.entry?.pending).toBeUndefined();
    expect(text(result.current.entry)).toBe('done');
    expect(fake.api.getTrafficEntry).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous entry while the next selection loads', async () => {
    put(1, 'one');
    put(2, 'two');
    const { result, rerender } = renderHook(({ id }) => useTrafficEntry(id), {
      initialProps: { id: 1 },
    });
    await settle();
    rerender({ id: 2 });
    expect(result.current.entry?.trafficId).toBe(1);
    expect(result.current.ready).toBe(false);
    await settle();
    expect(result.current.entry?.trafficId).toBe(2);
  });

  it('ignores an answer that arrives after a newer selection', async () => {
    put(1, 'one');
    put(2, 'two');
    let releaseFirst: (value: unknown) => void = () => {};
    fake.api.getTrafficEntry.mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = () => resolve(main.get(1))))
    );
    const { result, rerender } = renderHook(({ id }) => useTrafficEntry(id), {
      initialProps: { id: 1 },
    });
    rerender({ id: 2 });
    await settle();
    expect(result.current.entry?.trafficId).toBe(2);
    await act(async () => releaseFirst(undefined));
    expect(result.current.entry?.trafficId).toBe(2);
  });

  it('returns nothing once the row is gone, and nothing is asked for no id', async () => {
    put(1, 'one');
    const { result, rerender } = renderHook(({ id }) => useTrafficEntry(id), {
      initialProps: { id: 1 as number | null },
    });
    await settle();
    act(() => useProxyStore.setState({ traffic: [] }));
    expect(result.current.entry).toBeUndefined();

    fake.api.getTrafficEntry.mockClear();
    rerender({ id: null });
    await settle();
    expect(result.current).toEqual({ entry: undefined, ready: true });
    expect(fake.api.getTrafficEntry).not.toHaveBeenCalled();
  });
});
