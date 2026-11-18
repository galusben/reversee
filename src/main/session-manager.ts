// Owns one Session per tab and keeps them in step with the saved tabs
// (settings.ts): a created tab gets a session, a closed tab's worker is
// stopped. Holds what sessions share — the id counters, the compiled proto
// specs, the certificates — and publishes a summary of every tab.
import {
  closeTab,
  createTab,
  getActiveTabId,
  getTabsState,
  moveTab,
  onSettingsChanged,
  onTabsChanged,
  renameTab,
  setActiveTabId,
  type CreateTabOptions,
  type CreateTabResult,
  type RenameTabResult,
} from './settings';
import { Session, type SessionDeps, type SessionSink } from './session';
import { resolveTabRef, type StoredTab, type TabSummary, type TabsSnapshot } from '../shared/tabs';
import type { GrpcProtoBundle, TrafficEntry } from '../shared/types';
import type { BreakpointHit } from '../shared/ipc';

export interface SessionManagerEvents extends SessionSink {
  /** The tab list, the active tab, or a tab's counters changed. */
  tabsChanged(snapshot: TabsSnapshot): void;
}

export type SessionManagerDeps = Pick<
  SessionDeps,
  'getLeafCert' | 'issueCert' | 'createProxyHost'
> & {
  events: SessionManagerEvents;
  /** Delay for coalescing counter-only summary updates (busy traffic). */
  summaryDelayMs?: number;
};

export class SessionManager {
  private sessions = new Map<string, Session>();
  private nextTrafficId = 1;
  private nextHitId = 1;
  private bundle: GrpcProtoBundle | null = null;
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: Array<() => void> = [];

  constructor(private deps: SessionManagerDeps) {
    this.reconcile(getTabsState().tabs);
    this.unsubscribe.push(
      onTabsChanged((state) => {
        this.reconcile(state.tabs);
        this.emitTabs();
      }),
      onSettingsChanged((settings, tabId) => {
        this.sessions.get(tabId)?.applySettings(settings);
        // The history cap is global.
        for (const session of this.sessions.values()) {
          session.trafficStore.setCap(settings.trafficCap);
        }
        // Port and destination show in the tab strip.
        this.emitTabs();
      })
    );
  }

  private sink(): SessionSink {
    const events = this.deps.events;
    // Counters change with traffic and held requests: coalesce those updates.
    const counted =
      <A extends unknown[]>(fn: (session: Session, ...args: A) => void) =>
      (session: Session, ...args: A): void => {
        if (!this.sessions.has(session.id)) return; // a closed tab's last words
        fn(session, ...args);
        this.scheduleTabs();
      };
    return {
      traffic: counted((s, e: TrafficEntry) => events.traffic(s, e)),
      trafficCleared: counted((s) => events.trafficCleared(s)),
      state: (session) => {
        if (!this.sessions.has(session.id)) return;
        events.state(session);
        this.emitTabs();
      },
      error: counted((s, e) => events.error(s, e)),
      breakpointHit: (session, hit) => {
        if (!this.sessions.has(session.id)) return;
        events.breakpointHit(session, hit);
        // A held request blocks a real client: tell the tab strip at once.
        this.emitTabs();
      },
      breakpointResumed: counted((s, id: number) => events.breakpointResumed(s, id)),
      breakpointsChanged: (s, rules) => {
        if (this.sessions.has(s.id)) events.breakpointsChanged(s, rules);
      },
      breakpointErrors: (s, errors) => {
        if (this.sessions.has(s.id)) events.breakpointErrors(s, errors);
      },
    };
  }

  private reconcile(tabs: StoredTab[]): void {
    const wanted = new Set(tabs.map((t) => t.id));
    for (const [id, session] of this.sessions) {
      if (wanted.has(id)) continue;
      this.sessions.delete(id);
      session.dispose();
    }
    for (const tab of tabs) {
      if (this.sessions.has(tab.id)) continue;
      const session = new Session(tab.id, {
        sink: this.sink(),
        allocateTrafficId: () => this.nextTrafficId++,
        allocateHitId: () => this.nextHitId++,
        getLeafCert: () => this.deps.getLeafCert(),
        issueCert: (host) => this.deps.issueCert(host),
        portOwner: (port, exceptTabId) => this.portOwner(port, exceptTabId),
        protoBundle: () => this.bundle,
        createProxyHost: this.deps.createProxyHost,
      });
      this.sessions.set(tab.id, session);
      session.applySettings();
    }
  }

  private portOwner(port: number, exceptTabId: string): { id: string; name: string } | undefined {
    for (const session of this.sessions.values()) {
      if (session.id === exceptTabId || !session.isRunning) continue;
      if (session.boundPort === port) {
        const tab = getTabsState().tabs.find((t) => t.id === session.id);
        return { id: session.id, name: tab?.name ?? session.id };
      }
    }
    return undefined;
  }

  // ---- lookup ----

  get activeTabId(): string {
    return getActiveTabId();
  }

  active(): Session {
    return this.get(this.activeTabId) as Session;
  }

  get(tabId: string): Session | undefined {
    return this.sessions.get(tabId);
  }

  all(): Session[] {
    const order = getTabsState().tabs.map((t) => t.id);
    return order.map((id) => this.sessions.get(id)).filter((s): s is Session => Boolean(s));
  }

  /**
   * The tab an id or name refers to; the active tab when `ref` is omitted.
   * Throws (with the valid choices) when nothing matches.
   */
  resolve(ref?: unknown): Session {
    if (ref === undefined || ref === null || ref === '') return this.active();
    if (typeof ref !== 'string') throw new Error('tab must be a tab id (like "t2") or a tab name');
    const tabs = getTabsState().tabs;
    const tab = resolveTabRef(tabs, ref);
    const session = tab && this.sessions.get(tab.id);
    if (!session) {
      const choices = tabs.map((t) => `${t.id} "${t.name}"`).join(', ');
      throw new Error(`no tab "${ref}" (open tabs: ${choices}; see list_tabs)`);
    }
    return session;
  }

  /** The tab holding a captured request (traffic ids are unique across tabs). */
  findTraffic(trafficId: number): { session: Session; entry: TrafficEntry } | undefined {
    for (const session of this.sessions.values()) {
      const entry = session.trafficStore.get(trafficId);
      if (entry) return { session, entry };
    }
    return undefined;
  }

  /** The tab holding a request/response at a breakpoint. */
  findHeld(hitId: number): Session | undefined {
    for (const session of this.sessions.values()) if (session.holds(hitId)) return session;
    return undefined;
  }

  allHeldHits(): BreakpointHit[] {
    return this.all().flatMap((s) => s.heldHits);
  }

  // ---- tab lifecycle (persisted in settings; sessions follow via reconcile) ----

  create(options?: CreateTabOptions): CreateTabResult {
    return createTab(options);
  }

  close(tabId: string): boolean {
    return closeTab(tabId);
  }

  rename(tabId: string, name: string): RenameTabResult {
    return renameTab(tabId, name);
  }

  move(tabId: string, toIndex: number): void {
    moveTab(tabId, toIndex);
  }

  setActive(tabId: string): void {
    setActiveTabId(tabId);
  }

  // ---- shared resources ----

  setProtoSpecs(bundle: GrpcProtoBundle): void {
    this.bundle = bundle;
    for (const session of this.sessions.values()) session.setProtoSpecs(bundle);
  }

  // ---- summaries ----

  summary(session: Session, tab?: StoredTab): TabSummary {
    const stored = tab ?? getTabsState().tabs.find((t) => t.id === session.id);
    const s = session.settings;
    const traffic = session.trafficStore.getAll();
    let pending = 0;
    for (const entry of traffic) if (entry.pending) pending++;
    return {
      id: session.id,
      name: stored?.name ?? session.id,
      nameIsCustom: stored?.nameIsCustom ?? false,
      running: session.isRunning,
      ...(session.boundPort !== undefined ? { port: session.boundPort } : {}),
      listenProtocol: s.captureAll ? 'http' : s.listenProtocol,
      listenPort: s.listenPort,
      captureAll: s.captureAll,
      destination: !s.captureAll && s.dest ? `${s.destProtocol}://${s.dest}:${s.destPort}` : null,
      trafficCount: traffic.length,
      pendingCount: pending,
      heldCount: session.heldHits.length,
      ...(session.error ? { error: session.error } : {}),
    };
  }

  snapshot(): TabsSnapshot {
    const state = getTabsState();
    return {
      activeTabId: state.activeTabId,
      tabs: state.tabs
        .map((tab) => {
          const session = this.sessions.get(tab.id);
          return session ? this.summary(session, tab) : undefined;
        })
        .filter((t): t is TabSummary => Boolean(t)),
    };
  }

  private emitTabs(): void {
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.summaryTimer = null;
    this.deps.events.tabsChanged(this.snapshot());
  }

  private scheduleTabs(): void {
    if (this.summaryTimer) return;
    this.summaryTimer = setTimeout(() => this.emitTabs(), this.deps.summaryDelayMs ?? 200);
  }

  /** Stops every worker (app quitting). */
  dispose(): void {
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    for (const off of this.unsubscribe) off();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}
