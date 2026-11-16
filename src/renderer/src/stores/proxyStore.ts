import { create } from 'zustand';
import type { AppSettings } from '../../../shared/settings-schema';
import { defaultSettings } from '../../../shared/settings-schema';
import type {
  ProxyErrorInfo,
  ReplayOverrides,
  ReplayResult,
  RootCertStatus,
} from '../../../shared/ipc';
import type { TrafficEntry } from '../../../shared/types';
import { useUiStore } from './uiStore';

/**
 * Mirror of the main-process TrafficStore ring buffer. Updates (a pending
 * request completing, a stream growing) nearly always target a recent entry,
 * so the lookup runs from the end.
 */
export function upsert(traffic: TrafficEntry[], entry: TrafficEntry, cap: number): TrafficEntry[] {
  const index = traffic.findLastIndex((e) => e.trafficId === entry.trafficId);
  let next;
  if (index >= 0) {
    next = traffic.slice();
    next[index] = entry;
  } else {
    next = [...traffic, entry];
    if (next.length > cap) next.splice(0, next.length - cap);
  }
  return next;
}

export type SortKey = 'id' | 'method' | 'host' | 'url' | 'status' | 'type' | 'size' | 'duration';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

interface ProxyStore {
  settings: AppSettings | null;
  running: boolean;
  port?: number;
  error: ProxyErrorInfo | null;
  traffic: TrafficEntry[];
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
}

export const useProxyStore = create<ProxyStore>((set, get) => ({
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

    const [settings, traffic] = await Promise.all([
      window.reversee.getSettings(),
      window.reversee.getTraffic(),
    ]);
    set({ settings, traffic });
    void window.reversee.getCertStatus().then((certStatus) => set({ certStatus }));

    window.reversee.onCertStatus((certStatus) => set({ certStatus }));
    window.reversee.onSettingsChanged((settings) => {
      // A smaller history cap takes effect at once, like in main.
      const traffic = get().traffic;
      const over = traffic.length - settings.trafficCap;
      set(over > 0 ? { settings, traffic: traffic.slice(over) } : { settings });
    });
    window.reversee.onProxyState(({ running, port }) => set({ running, port }));
    window.reversee.onProxyError((error) => set({ error, running: false }));
    window.reversee.onTraffic((entry) =>
      set({
        traffic: upsert(
          get().traffic,
          entry,
          get().settings?.trafficCap ?? defaultSettings.trafficCap
        ),
      })
    );
    window.reversee.onTrafficCleared(() => set({ traffic: [], selectedId: null }));
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
