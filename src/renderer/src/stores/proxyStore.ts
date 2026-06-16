import { create } from 'zustand';
import type { AppSettings } from '../../../shared/settings-schema';
import type { ProxyErrorInfo } from '../../../shared/ipc';
import type { TrafficEntry } from '../../../shared/types';

// Mirror of the main-process TrafficStore ring buffer.
const TRAFFIC_CAP = 1000;

function upsert(traffic: TrafficEntry[], entry: TrafficEntry): TrafficEntry[] {
  const index = traffic.findIndex((e) => e.trafficId === entry.trafficId);
  let next;
  if (index >= 0) {
    next = traffic.slice();
    next[index] = entry;
  } else {
    next = [...traffic, entry];
    if (next.length > TRAFFIC_CAP) next.splice(0, next.length - TRAFFIC_CAP);
  }
  return next;
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

  init(): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  clearTraffic(): Promise<void>;
  select(id: number | null): void;
  toggleScrollLock(): void;
  setFilterText(text: string): void;
  toggleErrorsOnly(): void;
  dismissError(): void;
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

    window.reversee.onSettingsChanged((settings) => set({ settings }));
    window.reversee.onProxyState(({ running, port }) => set({ running, port }));
    window.reversee.onProxyError((error) => set({ error, running: false }));
    window.reversee.onTraffic((entry) => set({ traffic: upsert(get().traffic, entry) }));
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

  dismissError() {
    set({ error: null });
  },
}));
