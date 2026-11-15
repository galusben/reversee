import { create } from 'zustand';
import type { MockRule, RouteRule } from '../../../shared/types';

/** A new, unsaved rule the Routes and mocks screen opens with. */
export type RuleSeed =
  { kind: 'mock'; rule: Omit<MockRule, 'id'> } | { kind: 'route'; rule: Omit<RouteRule, 'id'> };

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
  rulesSeed: RuleSeed | null;
  /** Opens the screen; with a seed, a prefilled new rule is waiting to be saved. */
  setRulesOpen(open: boolean, seed?: RuleSeed): void;
  scriptsOpen: boolean;
  setScriptsOpen(open: boolean): void;
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
  rulesSeed: null,
  setRulesOpen: (rulesOpen, seed) => set({ rulesOpen, rulesSeed: (rulesOpen && seed) || null }),
  scriptsOpen: false,
  setScriptsOpen: (scriptsOpen) => set({ scriptsOpen }),
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
