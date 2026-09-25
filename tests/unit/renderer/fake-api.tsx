// Shared harness for renderer component tests: a vi.fn()-backed window.reversee
// (the preload bridge) whose event subscriptions can be driven from the test,
// store resets, the jsdom shims Radix needs, and a stand-in for the lazy
// Monaco editor (Monaco cannot run in jsdom; the real editor is covered e2e).
import { vi } from 'vitest';
import { defaultSettings } from '../../../src/shared/settings-schema';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
import { useBreakpointStore } from '../../../src/renderer/src/stores/breakpointStore';
import { useProtoSpecStore } from '../../../src/renderer/src/stores/protoSpecStore';
import { useUiStore } from '../../../src/renderer/src/stores/uiStore';

type Listener = (payload?: unknown) => void;

const SUBSCRIPTIONS = [
  'onTraffic',
  'onTrafficCleared',
  'onBreakpointHit',
  'onBreakpointErrors',
  'onOpenBreakpoints',
  'onOpenConnectAi',
  'onOpenProtoSpecs',
  'onProxyState',
  'onProxyError',
  'onSettingsChanged',
] as const;

export type Subscription = (typeof SUBSCRIPTIONS)[number];

export function installFakeApi() {
  const listeners = new Map<Subscription, Set<Listener>>();
  let settings = { ...defaultSettings, dest: 'api.test' };

  const api = {
    startProxy: vi.fn(() => Promise.resolve({ ok: true, port: settings.listenPort })),
    stopProxy: vi.fn(() => Promise.resolve()),
    getSettings: vi.fn(() => Promise.resolve(settings)),
    setSettings: vi.fn((patch: Record<string, unknown>) => {
      settings = { ...settings, ...patch };
      return Promise.resolve(settings);
    }),
    migrateLegacySettings: vi.fn(() => Promise.resolve()),
    getVersion: vi.fn(() => Promise.resolve('0.0.0-test')),
    getTraffic: vi.fn(() => Promise.resolve([])),
    clearTraffic: vi.fn(() => Promise.resolve()),
    copyToClipboard: vi.fn(() => Promise.resolve()),
    getBreakpoints: vi.fn(() => Promise.resolve([])),
    setBreakpoints: vi.fn(() => Promise.resolve()),
    resumeBreakpoint: vi.fn(() => Promise.resolve()),
    getProtoSpecs: vi.fn(() => Promise.resolve({ specs: [], errors: [] })),
    importProtoSpec: vi.fn(() => Promise.resolve({ specs: [], errors: [] })),
    removeProtoSpec: vi.fn(() => Promise.resolve({ specs: [], errors: [] })),
    ...Object.fromEntries(
      SUBSCRIPTIONS.map((name) => [
        name,
        vi.fn((cb: Listener) => {
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name)!.add(cb);
          return () => listeners.get(name)!.delete(cb);
        }),
      ])
    ),
  };

  (window as unknown as { reversee: typeof api }).reversee = api;

  return {
    api,
    setStoredSettings(patch: Record<string, unknown>) {
      settings = { ...settings, ...patch };
    },
    /** Simulate a main -> renderer event. */
    emit(name: Subscription, payload?: unknown) {
      for (const cb of listeners.get(name) ?? []) cb(payload);
    },
    listenerCount(name: Subscription) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}

export function resetStores(): void {
  useProxyStore.setState({
    settings: null,
    running: false,
    port: undefined,
    error: null,
    traffic: [],
    selectedId: null,
    scrollLocked: true,
    filterText: '',
    errorsOnly: false,
  });
  useBreakpointStore.setState({ rules: [], hits: [], compileErrors: [], editorOpen: false });
  useProtoSpecStore.setState({ specs: [], compileErrors: [], editorOpen: false, importing: false });
  useUiStore.setState({ connectAiOpen: false, summaryOpen: false });
}

/** Browser APIs Radix primitives touch that jsdom does not implement. */
export function installDomShims(): void {
  const g = globalThis as Record<string, unknown>;
  if (!g['ResizeObserver']) {
    g['ResizeObserver'] = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto['scrollIntoView'] ??= function () {};
  proto['hasPointerCapture'] ??= () => false;
  proto['setPointerCapture'] ??= function () {};
  proto['releasePointerCapture'] ??= function () {};
}

/** Stand-in for the lazily imported Monaco editor. */
export function FakeMonaco({
  value,
  language,
  readOnly = true,
  onChange,
}: {
  value: string;
  language: string;
  readOnly?: boolean;
  onChange?: (v: string) => void;
}) {
  return readOnly || !onChange ? (
    <pre data-testid="monaco" data-language={language}>
      {value}
    </pre>
  ) : (
    <textarea
      data-testid="monaco"
      data-language={language}
      defaultValue={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

let nextId = 1;
export function trafficEntry(overrides: Record<string, unknown> = {}) {
  return {
    trafficId: nextId++,
    request: {
      url: '/api/items',
      method: 'GET',
      headers: { accept: 'application/json' },
      curl: "curl 'http://api.test/api/items'",
    },
    response: {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"ok":true}'),
    },
    timings: { start: '2026-01-01T00:00:00.000Z', total: 12_000_000 },
    ...overrides,
  };
}
