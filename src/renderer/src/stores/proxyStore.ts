import { create } from 'zustand';
import type { AppSettings } from '../../../shared/settings-schema';
import type { ProxyErrorInfo } from '../../../shared/ipc';
import type { TrafficEntry } from '../../../shared/types';

// Renderer-side mirror until the main-process TrafficStore lands.
const TRAFFIC_CAP = 1000;

interface ProxyStore {
  settings: AppSettings | null;
  running: boolean;
  port?: number;
  error: ProxyErrorInfo | null;
  traffic: TrafficEntry[];
  selectedId: number | null;

  init(): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  clearTraffic(): void;
  select(id: number | null): void;
  dismissError(): void;
}

export const useProxyStore = create<ProxyStore>((set, get) => ({
  settings: null,
  running: false,
  port: undefined,
  error: null,
  traffic: [],
  selectedId: null,

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

    const settings = await window.reversee.getSettings();
    set({ settings });

    window.reversee.onSettingsChanged((settings) => set({ settings }));
    window.reversee.onProxyState(({ running, port }) => set({ running, port }));
    window.reversee.onProxyError((error) => set({ error, running: false }));
    window.reversee.onTraffic((entry) => {
      const traffic = [...get().traffic, entry];
      if (traffic.length > TRAFFIC_CAP) traffic.splice(0, traffic.length - TRAFFIC_CAP);
      set({ traffic });
    });
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

  clearTraffic() {
    set({ traffic: [], selectedId: null });
  },

  select(id) {
    set({ selectedId: id });
  },

  dismissError() {
    set({ error: null });
  },
}));
