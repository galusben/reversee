// Shared harness for renderer component tests: a vi.fn()-backed window.reversee
// (the preload bridge) whose event subscriptions can be driven from the test,
// store resets, the jsdom shims Radix needs, and a stand-in for the lazy
// Monaco editor (Monaco cannot run in jsdom; the real editor is covered e2e).
import { vi } from 'vitest';
import { act } from '@testing-library/react';
import { defaultSettings } from '../../../src/shared/settings-schema';
import { useProxyStore } from '../../../src/renderer/src/stores/proxyStore';
import { useBreakpointStore } from '../../../src/renderer/src/stores/breakpointStore';
import { useProtoSpecStore } from '../../../src/renderer/src/stores/protoSpecStore';
import { useUiStore } from '../../../src/renderer/src/stores/uiStore';
import { useTabsStore } from '../../../src/renderer/src/stores/tabsStore';
import type { TabSummary, TabsSnapshot } from '../../../src/shared/tabs';
import type { TrafficEntry } from '../../../src/shared/types';
import { mergeRecorded, recordMocks } from '../../../src/shared/record-mocks';

type Listener = (payload?: unknown) => void;

const SUBSCRIPTIONS = [
  'onTraffic',
  'onTrafficCleared',
  'onBreakpointHit',
  'onBreakpointErrors',
  'onOpenBreakpoints',
  'onOpenConnectAi',
  'onOpenProtoSpecs',
  'onBreakpointResumed',
  'onBreakpointsChanged',
  'onCertStatus',
  'onOpenPreferences',
  'onOpenRules',
  'onOpenScripts',
  'onFocusFilter',
  'onToggleProxy',
  'onProxyState',
  'onProxyError',
  'onSettingsChanged',
  'onTabsChanged',
  'onRenameTab',
] as const;

export type Subscription = (typeof SUBSCRIPTIONS)[number];

/** A tab summary for tests (one stopped tab named after api.test by default). */
export function tabSummary(patch: Partial<TabSummary> = {}): TabSummary {
  return {
    id: 't1',
    name: 'api.test',
    nameIsCustom: false,
    running: false,
    listenProtocol: 'http',
    listenPort: 8000,
    captureAll: false,
    destination: 'https://api.test:443',
    trafficCount: 0,
    pendingCount: 0,
    heldCount: 0,
    ...patch,
  };
}

export function installFakeApi() {
  const listeners = new Map<Subscription, Set<Listener>>();
  let settings = { ...defaultSettings, dest: 'api.test' };
  let tabs: TabsSnapshot = { activeTabId: 't1', tabs: [tabSummary()] };
  let certStatus = {
    notAfter: '2036-01-01T00:00:00.000Z',
    daysLeft: 3000,
    expired: false,
    expiringSoon: false,
  };

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
    // Plays main's part: tests seed the store with full entries, so the
    // "fetched" entry is the store's own (with its bodies).
    getTrafficEntry: vi.fn((id: number) =>
      Promise.resolve(useProxyStore.getState().traffic.find((e) => e.trafficId === id) ?? null)
    ),
    clearTraffic: vi.fn(() => Promise.resolve()),
    copyToClipboard: vi.fn(() => Promise.resolve()),
    getBreakpoints: vi.fn(() => Promise.resolve([])),
    setBreakpoints: vi.fn(() => Promise.resolve()),
    resumeBreakpoint: vi.fn(() => Promise.resolve()),
    getProtoSpecs: vi.fn(() => Promise.resolve({ specs: [], errors: [] })),
    importProtoSpec: vi.fn(() => Promise.resolve({ specs: [], errors: [] })),
    removeProtoSpec: vi.fn(() => Promise.resolve({ specs: [], errors: [] })),
    replayRequest: vi.fn(() => Promise.resolve({ ok: true, trafficId: 999 })),
    exportHar: vi.fn(() => Promise.resolve({ ok: true, path: '/tmp/out.har', count: 2 })),
    importHar: vi.fn(() => Promise.resolve({ ok: true, count: 3 })),
    recordMocks: vi.fn(() =>
      Promise.resolve({
        considered: 2,
        created: 2,
        replaced: 0,
        overLimit: 0,
        skipped: [],
        mocks: [],
      })
    ),
    // Runs the same shared conversion main's preview runs, over the store's entries.
    previewMocks: vi.fn((ids?: number[], options?: { ignoreQuery?: boolean }) => {
      const all = useProxyStore.getState().traffic as TrafficEntry[];
      const chosen = ids ? all.filter((e) => ids.includes(e.trafficId)) : all;
      const recording = recordMocks(chosen, options);
      const merged = mergeRecorded(useProxyStore.getState().settings?.mocks ?? [], recording);
      return Promise.resolve({
        considered: chosen.length,
        created: merged.added,
        replaced: merged.replaced,
        overLimit: merged.overLimit,
        skipped: recording.skipped,
        mocks: merged.stored,
      });
    }),
    getCertStatus: vi.fn(() => Promise.resolve(certStatus)),
    regenerateRootCert: vi.fn(() => Promise.resolve(certStatus)),
    pickFile: vi.fn(() => Promise.resolve('/picked/file.pem')),
    tryScript: vi.fn(() =>
      Promise.resolve({
        ok: true,
        before: {
          request: { method: 'GET', path: '/', host: 'h', port: 80, headers: {}, body: '' },
        },
        after: {
          request: { method: 'GET', path: '/', host: 'h', port: 80, headers: {}, body: '' },
        },
        changes: ['header x-debug added: true'],
        logs: ['GET /'],
      })
    ),
    getProxyState: vi.fn(() => Promise.resolve({ running: false })),
    getHeldHits: vi.fn(() => Promise.resolve([])),
    getTabs: vi.fn(() => Promise.resolve(tabs)),
    createTab: vi.fn(() => Promise.resolve({ ok: true, tabId: 't2' })),
    closeTab: vi.fn(() => Promise.resolve(true)),
    renameTab: vi.fn(() => Promise.resolve({ ok: true, tabId: 't1' })),
    moveTab: vi.fn(() => Promise.resolve()),
    setActiveTab: vi.fn(() => Promise.resolve()),
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
    setCertStatus(patch: Record<string, unknown>) {
      certStatus = { ...certStatus, ...patch };
    },
    setStoredSettings(patch: Record<string, unknown>) {
      settings = { ...settings, ...patch };
    },
    /** What getTabs resolves with (before init); emit 'onTabsChanged' to push a change. */
    setTabs(next: TabsSnapshot) {
      tabs = next;
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
    tabId: null,
    settings: null,
    running: false,
    port: undefined,
    error: null,
    traffic: [],
    selectedId: null,
    scrollLocked: true,
    filterText: '',
    errorsOnly: false,
    sort: { key: 'id', dir: 'asc' },
    certStatus: null,
  });
  useBreakpointStore.setState({
    tabId: null,
    rules: [],
    hits: [],
    compileErrors: [],
    editorOpen: false,
  });
  useTabsStore.setState({ tabs: [], activeTabId: null, renameRequest: 0, seen: {} });
  useProtoSpecStore.setState({ specs: [], compileErrors: [], editorOpen: false, importing: false });
  useUiStore.setState({
    connectAiOpen: false,
    summaryOpen: false,
    preferencesOpen: false,
    rulesOpen: false,
    recordMocks: null,
    replayEditorId: null,
    compareBaseId: null,
    compareIds: null,
    filterFocusRequest: 0,
    notice: null,
  });
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

/** Stand-in for the lazily imported Monaco diff editor. */
export function FakeMonacoDiff({
  original,
  modified,
  language,
}: {
  original: string;
  modified: string;
  language: string;
}) {
  return (
    <div data-testid="monaco-diff" data-language={language}>
      <pre data-testid="diff-original">{original}</pre>
      <pre data-testid="diff-modified">{modified}</pre>
    </div>
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

/**
 * Lets pending fetches from the fake main settle (the window fetches full
 * entries with getTrafficEntry and the mock preview with previewMocks).
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
