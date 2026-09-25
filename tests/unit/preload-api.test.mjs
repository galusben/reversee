// The preload bridge (src/preload/index.ts) is the renderer's only way into
// main. Pin its contract: exactly one global ('reversee'), exactly the RevAPI
// methods, each wired to its IPC channel, and no raw ipcRenderer leaking out.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc';

const exposed = {};
const listeners = new Map();
const ipcRenderer = {
  invoke: vi.fn(() => Promise.resolve('result')),
  on: vi.fn((channel, fn) => listeners.set(channel, fn)),
  removeListener: vi.fn((channel, fn) => {
    if (listeners.get(channel) === fn) listeners.delete(channel);
  }),
};

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key, api) => {
      exposed[key] = api;
    },
  },
  ipcRenderer,
}));

beforeAll(async () => {
  await import('../../src/preload/index');
});

beforeEach(() => {
  vi.clearAllMocks();
});

// method -> [channel, args used to call it]
const INVOKES = {
  startProxy: [IPC.proxyStart, []],
  stopProxy: [IPC.proxyStop, []],
  getSettings: [IPC.settingsGet, []],
  setSettings: [IPC.settingsSet, [{ dest: 'a.com' }]],
  migrateLegacySettings: [IPC.settingsMigrateLegacy, [{ old: true }]],
  getVersion: [IPC.appVersion, []],
  getTraffic: [IPC.trafficGetAll, []],
  clearTraffic: [IPC.trafficClear, []],
  copyToClipboard: [IPC.clipboardWrite, ['text']],
  getBreakpoints: [IPC.breakpointsGet, []],
  setBreakpoints: [IPC.breakpointsSet, [[{ id: 'x', path: '/', methods: ['GET'] }]]],
  resumeBreakpoint: [IPC.breakpointResume, [7, { url: '/', method: 'GET', headers: {} }]],
  getProtoSpecs: [IPC.protoSpecsGet, []],
  importProtoSpec: [IPC.protoSpecsImport, []],
  removeProtoSpec: [IPC.protoSpecsRemove, ['spec-id']],
};

const SUBSCRIPTIONS = {
  onTraffic: IPC.trafficEvent,
  onTrafficCleared: IPC.trafficClearedEvent,
  onBreakpointHit: IPC.breakpointHitEvent,
  onBreakpointErrors: IPC.breakpointErrorsEvent,
  onOpenBreakpoints: IPC.openBreakpointsEvent,
  onOpenConnectAi: IPC.openConnectAiEvent,
  onOpenProtoSpecs: IPC.openProtoSpecsEvent,
  onProxyState: IPC.proxyStateEvent,
  onProxyError: IPC.proxyErrorEvent,
  onSettingsChanged: IPC.settingsChangedEvent,
};

describe('preload bridge', () => {
  it('exposes only window.reversee', () => {
    expect(Object.keys(exposed)).toEqual(['reversee']);
  });

  it('exposes exactly the RevAPI surface, all functions', () => {
    const api = exposed.reversee;
    expect(Object.keys(api).sort()).toEqual(
      [...Object.keys(INVOKES), ...Object.keys(SUBSCRIPTIONS)].sort()
    );
    for (const value of Object.values(api)) expect(typeof value).toBe('function');
    // Nothing that looks like raw IPC access.
    for (const key of ['invoke', 'send', 'on', 'ipcRenderer']) expect(api).not.toHaveProperty(key);
  });

  it.each(Object.entries(INVOKES))('%s invokes its channel', async (method, [channel, args]) => {
    const result = await exposed.reversee[method](...args);
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(channel, ...args);
    expect(result).toBe('result');
  });

  it.each(Object.entries(SUBSCRIPTIONS))(
    '%s subscribes, forwards payloads without the event, and unsubscribes',
    (method, channel) => {
      const cb = vi.fn();
      const off = exposed.reversee[method](cb);
      expect(ipcRenderer.on).toHaveBeenCalledWith(channel, expect.any(Function));

      const listener = listeners.get(channel);
      listener({ sender: 'event-object' }, { payload: 1 });
      expect(cb).toHaveBeenCalledExactlyOnceWith({ payload: 1 });

      off();
      expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener);
      expect(listeners.has(channel)).toBe(false);
    }
  );

  it('covers every renderer-facing IPC channel', () => {
    const wired = new Set([
      ...Object.values(INVOKES).map(([c]) => c),
      ...Object.values(SUBSCRIPTIONS),
    ]);
    expect(new Set(Object.values(IPC))).toEqual(wired);
  });
});
