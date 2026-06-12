import { create } from 'zustand';
import type { BreakpointHit, BreakpointResume } from '../../../shared/ipc';
import type { BreakpointCompileError, BreakpointRule } from '../../../shared/types';

/** Stable rule id; methods are sorted so [GET,POST] and [POST,GET] dedupe
 * (the 1.x id concatenated methods unsorted and created duplicates). */
export function ruleId(path: string, methods: string[]): string {
  return [...methods].sort().join(',') + ' ' + path;
}

interface BreakpointStore {
  rules: BreakpointRule[];
  /** FIFO queue of held requests; the head is shown in the panel. */
  hits: BreakpointHit[];
  compileErrors: BreakpointCompileError[];
  editorOpen: boolean;

  init(): Promise<void>;
  setEditorOpen(open: boolean): void;
  addRule(path: string, methods: string[]): Promise<void>;
  removeRule(id: string): Promise<void>;
  resume(id: number, params: BreakpointResume): Promise<void>;
}

export const useBreakpointStore = create<BreakpointStore>((set, get) => ({
  rules: [],
  hits: [],
  compileErrors: [],
  editorOpen: false,

  async init() {
    const rules = await window.reversee.getBreakpoints();
    set({ rules });
    window.reversee.onBreakpointHit((hit) => set({ hits: [...get().hits, hit] }));
    window.reversee.onBreakpointErrors((compileErrors) => set({ compileErrors }));
    window.reversee.onOpenBreakpoints(() => set({ editorOpen: true }));
  },

  setEditorOpen(open) {
    set({ editorOpen: open });
  },

  async addRule(path, methods) {
    const id = ruleId(path, methods);
    if (get().rules.some((r) => r.id === id)) return;
    const rules = [...get().rules, { id, path, methods }];
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
