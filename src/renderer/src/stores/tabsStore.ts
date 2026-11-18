import { create } from 'zustand';
import type { TabResult } from '../../../shared/ipc';
import type { TabSummary, TabsSnapshot } from '../../../shared/tabs';
import { useProxyStore, type TabView } from './proxyStore';
import { useBreakpointStore } from './breakpointStore';
import { useUiStore } from './uiStore';

/**
 * The tab strip. Main owns which tab is active; the window follows it: on a
 * switch the traffic, settings and breakpoint stores reload for the new tab,
 * and the table's view (filter, selection, sort) comes back as it was left.
 */
interface TabsStore {
  tabs: TabSummary[];
  activeTabId: string | null;
  /** Bumped to start renaming the active tab (Tabs → Rename Tab…). */
  renameRequest: number;
  /** Request count each tab had when last looked at (for the "new traffic" dot). */
  seen: Record<string, number>;

  init(): Promise<void>;
  select(tabId: string): Promise<void>;
  create(duplicateOf?: string): Promise<void>;
  close(tabId: string): Promise<void>;
  rename(tabId: string, name: string): Promise<TabResult>;
  move(tabId: string, toIndex: number): Promise<void>;
  requestRename(): void;
}

// What each tab's table looked like when the user left it.
const views = new Map<string, TabView>();

function applySnapshot(
  snapshot: TabsSnapshot,
  set: (s: Partial<TabsStore>) => void,
  get: () => TabsStore
): void {
  const previous = get();
  const switched = previous.activeTabId !== snapshot.activeTabId;
  const seen: Record<string, number> = {};
  for (const tab of snapshot.tabs) {
    const before = previous.seen[tab.id];
    // The shown tab is always read; a cleared tab has nothing unread.
    seen[tab.id] =
      tab.id === snapshot.activeTabId || before === undefined
        ? tab.trafficCount
        : Math.min(before, tab.trafficCount);
  }
  set({ tabs: snapshot.tabs, activeTabId: snapshot.activeTabId, seen });

  const open = new Set(snapshot.tabs.map((t) => t.id));
  for (const id of views.keys()) if (!open.has(id)) views.delete(id);

  const active = snapshot.tabs.find((t) => t.id === snapshot.activeTabId);
  const proxy = useProxyStore.getState();
  if (switched) {
    if (previous.activeTabId) {
      views.set(previous.activeTabId, proxy.viewState());
      // Dialogs edit the tab they were opened on.
      useUiStore.getState().closeTabDialogs();
      useBreakpointStore.getState().setEditorOpen(false);
      void proxy.loadTab(snapshot.activeTabId, views.get(snapshot.activeTabId));
      void useBreakpointStore.getState().loadTab(snapshot.activeTabId);
    } else {
      // First snapshot: the stores loaded the active tab in their own init.
      proxy.bindTab(snapshot.activeTabId);
      useBreakpointStore.getState().bindTab(snapshot.activeTabId);
    }
  }
  if (active) useProxyStore.setState({ running: active.running, port: active.port });

  // A held request blocks a real client: never let it go unnoticed in a background tab.
  if (previous.activeTabId) {
    for (const tab of snapshot.tabs) {
      if (tab.id === snapshot.activeTabId) continue;
      const before = previous.tabs.find((t) => t.id === tab.id)?.heldCount ?? 0;
      if (tab.heldCount > before) {
        useUiStore.getState().showNotice({
          kind: 'info',
          text: `"${tab.name}" is holding a request at a breakpoint — show`,
          tabId: tab.id,
        });
      }
    }
  }
}

export const useTabsStore = create<TabsStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  renameRequest: 0,
  seen: {},

  async init() {
    window.reversee.onTabsChanged((snapshot) => applySnapshot(snapshot, set, get));
    window.reversee.onRenameTab(() => get().requestRename());
    applySnapshot(await window.reversee.getTabs(), set, get);
  },

  async select(tabId) {
    if (tabId !== get().activeTabId) await window.reversee.setActiveTab(tabId);
  },

  async create(duplicateOf) {
    const result = await window.reversee.createTab(duplicateOf);
    if (!result.ok) useUiStore.getState().showNotice({ kind: 'error', text: result.error });
  },

  async close(tabId) {
    await window.reversee.closeTab(tabId);
  },

  rename(tabId, name) {
    return window.reversee.renameTab(tabId, name);
  },

  async move(tabId, toIndex) {
    await window.reversee.moveTab(tabId, toIndex);
  },

  requestRename() {
    set({ renameRequest: get().renameRequest + 1 });
  },
}));
