import { create } from 'zustand';
import type { MockRule, RouteRule } from '../../../shared/types';

/** A new, unsaved rule the Routes and mocks screen opens with. */
export type RuleSeed =
  { kind: 'mock'; rule: Omit<MockRule, 'id'> } | { kind: 'route'; rule: Omit<RouteRule, 'id'> };

export interface Notice {
  kind: 'info' | 'error';
  text: string;
  /** Clicking the notice shows this tab (e.g. a background tab holding a request). */
  tabId?: string;
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
  /** The "Record as mocks" dialog; trafficId offers that one request as the scope. */
  recordMocks: { trafficId?: number } | null;
  setRecordMocks(open: boolean, trafficId?: number): void;
  /** trafficId of the request open in the "Edit and Replay" dialog, if any. */
  replayEditorId: number | null;
  setReplayEditorId(id: number | null): void;
  /** trafficId marked as side A of a comparison ("Mark for Compare"). */
  compareBaseId: number | null;
  setCompareBaseId(id: number | null): void;
  /** The two trafficIds open in the Compare screen (A, B), if any. */
  compareIds: [number, number] | null;
  openCompare(a: number, b: number): void;
  closeCompare(): void;
  /** Bumped to ask the traffic table to focus its filter box. */
  filterFocusRequest: number;
  requestFilterFocus(): void;
  /** Transient message in the status bar (export finished, replay failed…). */
  notice: Notice | null;
  showNotice(notice: Notice): void;
  clearNotice(): void;
  /** Closes the dialogs that edit or show one tab's data (on a tab switch). */
  closeTabDialogs(): void;
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
  recordMocks: null,
  setRecordMocks: (open, trafficId) =>
    set({ recordMocks: open ? (trafficId === undefined ? {} : { trafficId }) : null }),
  replayEditorId: null,
  setReplayEditorId: (replayEditorId) => set({ replayEditorId }),
  compareBaseId: null,
  setCompareBaseId: (compareBaseId) => set({ compareBaseId }),
  compareIds: null,
  openCompare: (a, b) => {
    // The "Marked #N as A" hint is done once the comparison is open.
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    set({ compareIds: [a, b], compareBaseId: null, notice: null });
  },
  closeCompare: () => set({ compareIds: null }),
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
  closeTabDialogs: () =>
    set({
      summaryOpen: false,
      preferencesOpen: false,
      rulesOpen: false,
      rulesSeed: null,
      scriptsOpen: false,
      recordMocks: null,
      replayEditorId: null,
      compareBaseId: null,
      compareIds: null,
    }),
}));
