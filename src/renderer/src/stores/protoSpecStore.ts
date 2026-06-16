import { create } from 'zustand';
import type { ProtoSpec, ProtoSpecCompileError } from '../../../shared/types';

interface ProtoSpecStore {
  specs: ProtoSpec[];
  compileErrors: ProtoSpecCompileError[];
  editorOpen: boolean;
  importing: boolean;

  init(): Promise<void>;
  setEditorOpen(open: boolean): void;
  importSpec(): Promise<void>;
  removeSpec(id: string): Promise<void>;
}

export const useProtoSpecStore = create<ProtoSpecStore>((set) => ({
  specs: [],
  compileErrors: [],
  editorOpen: false,
  importing: false,

  async init() {
    const { specs, errors } = await window.reversee.getProtoSpecs();
    set({ specs, compileErrors: errors });
    window.reversee.onOpenProtoSpecs(() => set({ editorOpen: true }));
  },

  setEditorOpen(open) {
    set({ editorOpen: open });
  },

  async importSpec() {
    set({ importing: true });
    try {
      const { specs, errors } = await window.reversee.importProtoSpec();
      set({ specs, compileErrors: errors });
    } finally {
      set({ importing: false });
    }
  },

  async removeSpec(id) {
    const { specs, errors } = await window.reversee.removeProtoSpec(id);
    set({ specs, compileErrors: errors });
  },
}));
