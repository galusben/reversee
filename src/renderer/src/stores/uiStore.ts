import { create } from 'zustand';

export interface Notice {
  kind: 'info' | 'error';
  text: string;
}

interface UiStore {
  connectAiOpen: boolean;
  setConnectAiOpen(open: boolean): void;
  summaryOpen: boolean;
  setSummaryOpen(open: boolean): void;
  preferencesOpen: boolean;
  setPreferencesOpen(open: boolean): void;
  rulesOpen: boolean;
  setRulesOpen(open: boolean): void;
  /** trafficId of the request open in the "Edit and Replay" dialog, if any. */
  replayEditorId: number | null;
  setReplayEditorId(id: number | null): void;
  /** Bumped to ask the traffic table to focus its filter box. */
  filterFocusRequest: number;
  requestFilterFocus(): void;
  /** Transient message in the status bar (export finished, replay failed…). */
  notice: Notice | null;
  showNotice(notice: Notice): void;
  clearNotice(): void;
}

const NOTICE_MS = 6000;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

// Small store for cross-component dialog state (e.g. both the "Connect AI"
// button and the Help menu item open the same setup dialog).
export const useUiStore = create<UiStore>((set, get) => ({
  connectAiOpen: false,
  setConnectAiOpen: (connectAiOpen) => set({ connectAiOpen }),
  summaryOpen: false,
  setSummaryOpen: (summaryOpen) => set({ summaryOpen }),
  preferencesOpen: false,
  setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
  rulesOpen: false,
  setRulesOpen: (rulesOpen) => set({ rulesOpen }),
  replayEditorId: null,
  setReplayEditorId: (replayEditorId) => set({ replayEditorId }),
  filterFocusRequest: 0,
  requestFilterFocus: () => set({ filterFocusRequest: get().filterFocusRequest + 1 }),
  notice: null,
  showNotice: (notice) => {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ notice });
    noticeTimer = setTimeout(() => set({ notice: null }), NOTICE_MS);
  },
  clearNotice: () => {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    set({ notice: null });
  },
}));
