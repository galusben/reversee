import { create } from 'zustand';

interface UiStore {
  connectAiOpen: boolean;
  setConnectAiOpen(open: boolean): void;
  summaryOpen: boolean;
  setSummaryOpen(open: boolean): void;
}

// Small store for cross-component dialog state (e.g. both the "Connect AI"
// button and the Help menu item open the same setup dialog).
export const useUiStore = create<UiStore>((set) => ({
  connectAiOpen: false,
  setConnectAiOpen: (connectAiOpen) => set({ connectAiOpen }),
  summaryOpen: false,
  setSummaryOpen: (summaryOpen) => set({ summaryOpen }),
}));
