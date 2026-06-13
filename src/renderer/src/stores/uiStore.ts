import { create } from 'zustand';

interface UiStore {
  connectAiOpen: boolean;
  setConnectAiOpen(open: boolean): void;
}

// Small store so both the "Connect AI" button and the Help menu item open the
// same setup dialog.
export const useUiStore = create<UiStore>((set) => ({
  connectAiOpen: false,
  setConnectAiOpen: (connectAiOpen) => set({ connectAiOpen }),
}));
