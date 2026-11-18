import { create } from 'zustand';
import { ruleId } from '../../../shared/breakpoint-id';
import type { BreakpointHit, BreakpointResume } from '../../../shared/ipc';
import type {
  BreakpointCompileError,
  BreakpointPhase,
  BreakpointRule,
} from '../../../shared/types';

export { ruleId };

interface BreakpointStore {
  /** The tab whose rules and held exchanges these are (the active tab). */
  tabId: string | null;
  rules: BreakpointRule[];
  /** FIFO queue of held requests and responses; the head is shown in the panel. */
  hits: BreakpointHit[];
  compileErrors: BreakpointCompileError[];
  editorOpen: boolean;

  init(): Promise<void>;
  bindTab(tabId: string): void;
  /** Switches to another tab's rules and held exchanges. */
  loadTab(tabId: string): Promise<void>;
  setEditorOpen(open: boolean): void;
  addRule(path: string, methods: string[], phase?: BreakpointPhase): Promise<void>;
  removeRule(id: string): Promise<void>;
  resume(id: number, params: BreakpointResume): Promise<void>;
}

const forThisTab = (eventTabId: string | undefined, tabId: string | null): boolean =>
  !eventTabId || !tabId || eventTabId === tabId;

export const useBreakpointStore = create<BreakpointStore>((set, get) => ({
  tabId: null,
  rules: [],
  hits: [],
  compileErrors: [],
  editorOpen: false,

  async init() {
    const rules = await window.reversee.getBreakpoints();
    set({ rules });
    window.reversee.onBreakpointHit((hit) => {
      if (forThisTab(hit.tabId, get().tabId)) set({ hits: [...get().hits, hit] });
    });
    window.reversee.onBreakpointErrors((compileErrors) => set({ compileErrors }));
    window.reversee.onOpenBreakpoints(() => set({ editorOpen: true }));
    // An agent (MCP) can resume a held exchange or replace the rules too.
    window.reversee.onBreakpointResumed((id) =>
      set({ hits: get().hits.filter((h) => h.id !== id) })
    );
    window.reversee.onBreakpointsChanged((rules) => set({ rules }));
    // Stopping the proxy closes every held connection: nothing left to resume.
    window.reversee.onProxyState(({ running, tabId }) => {
      if (forThisTab(tabId, get().tabId) && !running && get().hits.length) set({ hits: [] });
    });
  },

  bindTab(tabId) {
    set({ tabId });
  },

  async loadTab(tabId) {
    set({ tabId, rules: [], hits: [], compileErrors: [] });
    const [rules, hits] = await Promise.all([
      window.reversee.getBreakpoints(),
      window.reversee.getHeldHits(),
    ]);
    if (get().tabId === tabId) set({ rules, hits });
  },

  setEditorOpen(open) {
    set({ editorOpen: open });
  },

  async addRule(path, methods, phase = 'request') {
    const id = ruleId(path, methods, phase);
    if (get().rules.some((r) => r.id === id)) return;
    const rules = [...get().rules, { id, path, methods, phase }];
    await window.reversee.setBreakpoints(rules);
    set({ rules, compileErrors: [] });
  },

  async removeRule(id) {
    const rules = get().rules.filter((r) => r.id !== id);
    await window.reversee.setBreakpoints(rules);
    set({ rules, compileErrors: get().compileErrors.filter((e) => e.id !== id) });
  },

  async resume(id, params) {
    await window.reversee.resumeBreakpoint(id, params);
    set({ hits: get().hits.filter((h) => h.id !== id) });
  },
}));
