import { create } from 'zustand';
import type { AppSettings } from '../../../shared/settings-schema';
import { defaultSettings } from '../../../shared/settings-schema';
import type {
  ProxyErrorInfo,
  ReplayOverrides,
  ReplayResult,
  RootCertStatus,
} from '../../../shared/ipc';
import type { TrafficRow } from '../../../shared/traffic-row';
import { useUiStore } from './uiStore';

/**
 * Mirror of the main-process TrafficStore ring buffer. Updates (a pending
 * request completing, a stream growing) nearly always target a recent entry,
 * so the lookup runs from the end.
 */
export function upsert(traffic: TrafficRow[], entry: TrafficRow, cap: number): TrafficRow[] {
  return upsertMany(traffic, [entry], cap);
}

/** Applies a batch of new/updated entries with one copy of the list. */
export function upsertMany(
  traffic: TrafficRow[],
  entries: TrafficRow[],
  cap: number
): TrafficRow[] {
  if (entries.length === 0) return traffic;
  const next = traffic.slice();
  for (const entry of entries) {
    // Main hands out increasing ids, so a new entry needs no search (a miss
    // would otherwise scan the whole history, up to 20,000 rows).
    const last = next.at(-1);
    if (!last || entry.trafficId > last.trafficId) {
      next.push(entry);
      continue;
    }
    const index = next.findLastIndex((e) => e.trafficId === entry.trafficId);
    if (index >= 0) next[index] = entry;
    else next.push(entry);
  }
  if (next.length > cap) next.splice(0, next.length - cap);
  return next;
}

/**
 * Traffic events are applied at most once per this interval. Under load main
 * sends hundreds of events a second; applying each one copied the whole list
 * and re-rendered the table every time.
 */
export const TRAFFIC_FLUSH_MS = 16;

export type SortKey = 'id' | 'method' | 'host' | 'url' | 'status' | 'type' | 'size' | 'duration';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** How a tab's traffic table was left, restored when the user comes back to it. */
export interface TabView {
  selectedId: number | null;
  scrollLocked: boolean;
  filterText: string;
  errorsOnly: boolean;
  sort: SortState;
}

const defaultView: TabView = {
  selectedId: null,
  scrollLocked: true,
  filterText: '',
  errorsOnly: false,
  sort: { key: 'id', dir: 'asc' },
};

interface ProxyStore {
  /** The tab this store mirrors (the active tab); null until the tabs load. */
  tabId: string | null;
  settings: AppSettings | null;
  running: boolean;
  port?: number;
  error: ProxyErrorInfo | null;
  traffic: TrafficRow[];
  selectedId: number | null;
  /** When locked (default), the table does not auto-scroll to new traffic. */
  scrollLocked: boolean;
  /** Free-text filter over the traffic table (shared filterTraffic semantics). */
  filterText: string;
  /** Restrict the table to failures. */
  errorsOnly: boolean;
  sort: SortState;
  /** Validity of the root CA behind the HTTPS listener. */
  certStatus: RootCertStatus | null;

  init(): Promise<void>;
  /** Marks which tab the data already loaded belongs to (no reload). */
  bindTab(tabId: string): void;
  /** Switches to another tab: reloads its settings, traffic and state, restoring `view`. */
  loadTab(tabId: string, view?: TabView): Promise<void>;
  viewState(): TabView;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  clearTraffic(): Promise<void>;
  select(id: number | null): void;
  toggleScrollLock(): void;
  setFilterText(text: string): void;
  toggleErrorsOnly(): void;
  /** Sorts by the column; a second click on the same column flips the direction. */
  sortBy(key: SortKey): void;
  dismissError(): void;
  /** Re-sends a captured request and selects the new entry. */
  replay(trafficId: number, overrides?: ReplayOverrides): Promise<ReplayResult>;
  exportHar(ids?: number[]): Promise<void>;
  importHar(): Promise<void>;
  regenerateRootCert(): Promise<void>;
  /** Applies traffic events still waiting for the next batch (tests, mostly). */
  flushTraffic(): void;
}

// Traffic events waiting to be applied in one batch.
let queuedTraffic: TrafficRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Until the initial snapshot has loaded, events are only queued: applying them
// first would be overwritten by the (older) snapshot.
let trafficLoaded = false;

function dropQueuedTraffic(): void {
  queuedTraffic = [];
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}

/** Whether an event from main concerns the tab this window shows. */
function forThisTab(eventTabId: string | undefined, tabId: string | null): boolean {
  return !eventTabId || !tabId || eventTabId === tabId;
}

export const useProxyStore = create<ProxyStore>((set, get) => ({
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

  async init() {
    // One-time import of pre-2.0 settings persisted in renderer localStorage.
    const legacy = localStorage.getItem('userSettings');
    if (legacy) {
      try {
        await window.reversee.migrateLegacySettings(JSON.parse(legacy));
      } catch {
        // Malformed legacy payload — nothing worth keeping.
      }
      localStorage.removeItem('userSettings');
    }

    // Listen before taking the snapshot: an exchange recorded while the
    // snapshot is in flight would otherwise never reach the table.
    trafficLoaded = false;
    dropQueuedTraffic();
    window.reversee.onTraffic((entry) => {
      // Main sends only the shown tab's traffic; this also drops stragglers from a tab just left.
      if (!forThisTab(entry.tabId, get().tabId)) return;
      queuedTraffic.push(entry);
      if (trafficLoaded && !flushTimer) {
        flushTimer = setTimeout(() => get().flushTraffic(), TRAFFIC_FLUSH_MS);
      }
    });
    window.reversee.onTrafficCleared((tabId) => {
      if (!forThisTab(tabId, get().tabId)) return;
      dropQueuedTraffic();
      set({ traffic: [], selectedId: null });
    });

    const [settings, traffic] = await Promise.all([
      window.reversee.getSettings(),
      window.reversee.getTraffic(),
    ]);
    set({ settings, traffic });
    trafficLoaded = true;
    get().flushTraffic();
    void window.reversee.getCertStatus().then((certStatus) => set({ certStatus }));

    window.reversee.onCertStatus((certStatus) => set({ certStatus }));
    window.reversee.onSettingsChanged((settings) => {
      // A smaller history cap takes effect at once, like in main.
      const traffic = get().traffic;
      const over = traffic.length - settings.trafficCap;
      set(over > 0 ? { settings, traffic: traffic.slice(over) } : { settings });
    });
    window.reversee.onProxyState(({ running, port, tabId }) => {
      if (forThisTab(tabId, get().tabId)) set({ running, port });
    });
    window.reversee.onProxyError((error) => {
      if (forThisTab(error.tabId, get().tabId)) set({ error, running: false });
    });
  },

  flushTraffic() {
    const batch = queuedTraffic;
    dropQueuedTraffic();
    if (batch.length === 0) return;
    set({
      traffic: upsertMany(
        get().traffic,
        batch,
        get().settings?.trafficCap ?? defaultSettings.trafficCap
      ),
    });
  },

  bindTab(tabId) {
    set({ tabId });
  },

  async loadTab(tabId, view = defaultView) {
    // Clear at once so the old tab's rows never show under the new tab's name.
    // As in init: queue live traffic while the snapshot loads, then apply it on top.
    trafficLoaded = false;
    dropQueuedTraffic();
    set({ tabId, traffic: [], error: null, ...view });
    const [settings, traffic, state] = await Promise.all([
      window.reversee.getSettings(),
      window.reversee.getTraffic(),
      window.reversee.getProxyState(),
    ]);
    if (get().tabId !== tabId) return; // switched again meanwhile
    set({ settings, traffic, running: state.running, port: state.port });
    trafficLoaded = true;
    get().flushTraffic();
    const { selectedId } = get();
    if (selectedId !== null && !get().traffic.some((e) => e.trafficId === selectedId)) {
      set({ selectedId: null });
    }
  },

  viewState() {
    const { selectedId, scrollLocked, filterText, errorsOnly, sort } = get();
    return { selectedId, scrollLocked, filterText, errorsOnly, sort };
  },

  async updateSettings(patch) {
    const settings = await window.reversee.setSettings(patch);
    set({ settings });
  },

  async start() {
    set({ error: null });
    const result = await window.reversee.startProxy();
    if (!result.ok) {
      set({ error: result.error });
    }
  },

  async stop() {
    await window.reversee.stopProxy();
  },

  async clearTraffic() {
    await window.reversee.clearTraffic();
    dropQueuedTraffic();
    set({ traffic: [], selectedId: null });
  },

  select(id) {
    set({ selectedId: id });
  },

  toggleScrollLock() {
    set({ scrollLocked: !get().scrollLocked });
  },

  setFilterText(text) {
    set({ filterText: text });
  },

  toggleErrorsOnly() {
    set({ errorsOnly: !get().errorsOnly });
  },

  sortBy(key) {
    const current = get().sort;
    set({
      sort:
        current.key === key
          ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
          : // Numbers are most useful biggest-first; text and ids ascending.
            { key, dir: key === 'size' || key === 'duration' ? 'desc' : 'asc' },
    });
  },

  dismissError() {
    set({ error: null });
  },

  async replay(trafficId, overrides) {
    const result = await window.reversee.replayRequest(trafficId, overrides);
    if (result.ok) set({ selectedId: result.trafficId });
    else
      useUiStore.getState().showNotice({ kind: 'error', text: `Replay failed: ${result.error}` });
    return result;
  },

  async exportHar(ids) {
    const result = await window.reversee.exportHar(ids);
    const { showNotice } = useUiStore.getState();
    if (result.ok) {
      showNotice({
        kind: 'info',
        text: `Exported ${result.count} request${result.count === 1 ? '' : 's'} to ${result.path}`,
      });
    } else if (!result.canceled) {
      showNotice({ kind: 'error', text: `Export failed: ${result.error ?? 'unknown error'}` });
    }
  },

  async importHar() {
    const result = await window.reversee.importHar();
    const { showNotice } = useUiStore.getState();
    if (result.ok) {
      showNotice({
        kind: 'info',
        text: `Imported ${result.count} request${result.count === 1 ? '' : 's'}`,
      });
    } else if (!result.canceled) {
      showNotice({ kind: 'error', text: result.error ?? 'Import failed' });
    }
  },

  async regenerateRootCert() {
    set({ certStatus: await window.reversee.regenerateRootCert() });
  },
}));
