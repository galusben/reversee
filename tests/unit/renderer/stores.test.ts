// @vitest-environment jsdom
// Renderer stores that mirror main-process state: the traffic mirror's
// upsert/cap semantics, start/stop error handling, and the proto spec store.
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeApi, resetStores, trafficEntry } from './fake-api';
import { useProxyStore, TRAFFIC_FLUSH_MS } from '../../../src/renderer/src/stores/proxyStore';
import { useProtoSpecStore } from '../../../src/renderer/src/stores/protoSpecStore';
import { useUiStore } from '../../../src/renderer/src/stores/uiStore';

let fake: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  resetStores();
  localStorage.clear();
  fake = installFakeApi();
});

const state = () => useProxyStore.getState();

describe('proxyStore', () => {
  it('init loads settings and traffic', async () => {
    fake.api.getTraffic.mockResolvedValueOnce([trafficEntry({ trafficId: 5 })] as never);
    await state().init();
    expect(state().settings?.dest).toBe('api.test');
    expect(state().traffic.map((e) => e.trafficId)).toEqual([5]);
  });

  it('upserts streamed traffic by id and caps the mirror at 1000 entries', async () => {
    await state().init();
    for (let i = 1; i <= 1005; i++) fake.emit('onTraffic', trafficEntry({ trafficId: i }));
    // Events are applied in batches, not one store update (and render) each.
    expect(state().traffic).toHaveLength(0);
    state().flushTraffic();
    expect(state().traffic).toHaveLength(1000);
    expect(state().traffic[0].trafficId).toBe(6);

    fake.emit(
      'onTraffic',
      trafficEntry({ trafficId: 500, response: { statusCode: 418, headers: {} } })
    );
    state().flushTraffic();
    expect(state().traffic).toHaveLength(1000);
    expect(state().traffic.find((e) => e.trafficId === 500)?.response.statusCode).toBe(418);
  });

  it('clearing traffic (locally or from main) also clears the selection', async () => {
    await state().init();
    fake.emit('onTraffic', trafficEntry({ trafficId: 1 }));
    state().flushTraffic();
    state().select(1);
    await state().clearTraffic();
    expect(state()).toMatchObject({ traffic: [], selectedId: null });

    fake.emit('onTraffic', trafficEntry({ trafficId: 2 }));
    state().select(2);
    fake.emit('onTraffic', trafficEntry({ trafficId: 3 })); // still queued when the clear arrives
    fake.emit('onTrafficCleared');
    state().flushTraffic();
    expect(state()).toMatchObject({ traffic: [], selectedId: null });
  });

  it('applies a burst of events in one batch after the flush interval', async () => {
    await state().init();
    let updates = 0;
    const unsubscribe = useProxyStore.subscribe(() => updates++);
    for (let i = 1; i <= 50; i++) fake.emit('onTraffic', trafficEntry({ trafficId: i }));
    fake.emit(
      'onTraffic',
      trafficEntry({ trafficId: 1, response: { statusCode: 500, headers: {} } })
    );
    await new Promise((r) => setTimeout(r, TRAFFIC_FLUSH_MS * 3));
    unsubscribe();
    expect(updates).toBe(1);
    expect(state().traffic).toHaveLength(50);
    expect(state().traffic[0].response.statusCode).toBe(500);
  });

  it('keeps traffic that arrives while the initial snapshot is loading', async () => {
    let resolveSnapshot: (value: never) => void = () => {};
    fake.api.getTraffic.mockReturnValueOnce(new Promise((r) => (resolveSnapshot = r)) as never);
    const loading = state().init();
    await Promise.resolve();
    fake.emit('onTraffic', trafficEntry({ trafficId: 2 }));
    fake.emit(
      'onTraffic',
      trafficEntry({ trafficId: 1, response: { statusCode: 201, headers: {} } })
    );
    resolveSnapshot([trafficEntry({ trafficId: 1 })] as never);
    await loading;
    expect(state().traffic.map((e) => [e.trafficId, e.response.statusCode])).toEqual([
      [1, 201],
      [2, 200],
    ]);
  });

  it('start clears a previous error and records a new one on failure', async () => {
    useProxyStore.setState({ error: { message: 'old' } });
    await state().start();
    expect(state().error).toBeNull();

    fake.api.startProxy.mockResolvedValueOnce({
      ok: false,
      error: { code: 'EACCES', message: 'denied' },
    } as never);
    await state().start();
    expect(state().error).toEqual({ code: 'EACCES', message: 'denied' });
    state().dismissError();
    expect(state().error).toBeNull();
  });

  it('a proxy error from main marks the proxy stopped', async () => {
    await state().init();
    fake.emit('onProxyState', { running: true, port: 1 });
    fake.emit('onProxyError', { message: 'worker crashed' });
    expect(state()).toMatchObject({ running: false, error: { message: 'worker crashed' } });
  });

  it('updateSettings stores what main returns', async () => {
    await state().updateSettings({ dest: 'new.test' });
    expect(fake.api.setSettings).toHaveBeenCalledWith({ dest: 'new.test' });
    expect(state().settings?.dest).toBe('new.test');
  });

  it('toggles', () => {
    state().toggleScrollLock();
    state().toggleErrorsOnly();
    state().setFilterText('abc');
    expect(state()).toMatchObject({ scrollLocked: false, errorsOnly: true, filterText: 'abc' });
  });
});

describe('protoSpecStore', () => {
  it('init loads specs and errors and listens for the menu', async () => {
    fake.api.getProtoSpecs.mockResolvedValueOnce({
      specs: [{ id: 'a' }],
      errors: [{ id: 'a', error: 'x' }],
    } as never);
    await useProtoSpecStore.getState().init();
    expect(useProtoSpecStore.getState().specs).toEqual([{ id: 'a' }]);
    expect(useProtoSpecStore.getState().compileErrors).toHaveLength(1);
    fake.emit('onOpenProtoSpecs');
    expect(useProtoSpecStore.getState().editorOpen).toBe(true);
  });
});

describe('uiStore', () => {
  it('tracks dialog visibility', () => {
    useUiStore.getState().setConnectAiOpen(true);
    useUiStore.getState().setSummaryOpen(true);
    expect(useUiStore.getState()).toMatchObject({ connectAiOpen: true, summaryOpen: true });
  });
});
