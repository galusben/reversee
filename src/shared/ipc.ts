// IPC contracts: renderer <-> main channels (exposed through the preload
// bridge) and main <-> proxy utilityProcess messages. Channel names follow
// domain:action. This module must stay platform-neutral.
import type { AppSettings } from './settings-schema';
import type { RecordOptions, SkipGroup, StoredMock } from './record-mocks';
import type { TabsSnapshot } from './tabs';
import type { TrafficRow } from './traffic-row';
import type {
  BreakpointCompileError,
  BreakpointPhase,
  BreakpointRule,
  GrpcProtoBundle,
  Headers,
  ProtoSpec,
  ProtoSpecCompileError,
  ProxySettings,
  RuleSet,
  ScriptKind,
  ScriptSet,
  ScriptTrialExchange,
  ScriptTrialInput,
  ScriptTrialResult,
  TrafficEntry,
} from './types';

export const IPC = {
  proxyStart: 'proxy:start',
  proxyStop: 'proxy:stop',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsMigrateLegacy: 'settings:migrate-legacy',
  appVersion: 'app:version',
  trafficGetAll: 'traffic:get-all',
  trafficGet: 'traffic:get',
  trafficClear: 'traffic:clear',
  clipboardWrite: 'clipboard:write',
  breakpointsGet: 'breakpoints:get',
  breakpointsSet: 'breakpoints:set',
  breakpointResume: 'breakpoint:resume',
  protoSpecsGet: 'proto-specs:get',
  protoSpecsImport: 'proto-specs:import',
  protoSpecsRemove: 'proto-specs:remove',
  trafficReplay: 'traffic:replay',
  trafficExportHar: 'traffic:export-har',
  trafficImportHar: 'traffic:import-har',
  trafficRecordMocks: 'traffic:record-mocks',
  trafficPreviewMocks: 'traffic:preview-mocks',
  certStatusGet: 'cert:status',
  certRegenerate: 'cert:regenerate',
  filePick: 'file:pick',
  scriptTry: 'script:try',
  proxyStateGet: 'proxy:state-get',
  breakpointsHeld: 'breakpoints:held',
  tabsGet: 'tabs:get',
  tabsCreate: 'tabs:create',
  tabsClose: 'tabs:close',
  tabsRename: 'tabs:rename',
  tabsMove: 'tabs:move',
  tabsSetActive: 'tabs:set-active',
  // main -> renderer events
  trafficEvent: 'proxy:traffic',
  trafficClearedEvent: 'proxy:traffic-cleared',
  proxyStateEvent: 'proxy:state',
  proxyErrorEvent: 'proxy:error',
  settingsChangedEvent: 'settings:changed',
  breakpointHitEvent: 'breakpoint:hit',
  breakpointErrorsEvent: 'breakpoint:errors',
  openBreakpointsEvent: 'ui:open-breakpoints',
  openConnectAiEvent: 'ui:open-connect-ai',
  openProtoSpecsEvent: 'ui:open-proto-specs',
  breakpointResumedEvent: 'breakpoint:resumed',
  breakpointsChangedEvent: 'breakpoints:changed',
  certStatusEvent: 'cert:status-changed',
  openPreferencesEvent: 'ui:open-preferences',
  openRulesEvent: 'ui:open-rules',
  openScriptsEvent: 'ui:open-scripts',
  focusFilterEvent: 'ui:focus-filter',
  toggleProxyEvent: 'ui:toggle-proxy',
  tabsChangedEvent: 'tabs:changed',
  renameTabEvent: 'ui:rename-tab',
} as const;

/** Outcome of creating or renaming a tab. */
export type TabResult = { ok: true; tabId: string } | { ok: false; error: string };

/** What "Record as mocks" saved, and what it left out and why. */
export interface RecordMocksResult {
  /** Captured exchanges looked at. */
  considered: number;
  created: number;
  /** Saved mocks for the same method and URL that were updated in place. */
  replaced: number;
  /** Left out because the rule list is full. */
  overLimit: number;
  skipped: SkipGroup[];
  mocks: StoredMock[];
}

/** Saved proto specs plus the latest compile errors, returned after each mutation. */
export interface ProtoSpecsResult {
  specs: ProtoSpec[];
  errors: ProtoSpecCompileError[];
}

export interface ProxyState {
  running: boolean;
  port?: number;
  /** The tab whose proxy this is (events from main always carry it). */
  tabId?: string;
}

export interface ProxyErrorInfo {
  code?: string;
  message: string;
  /** The tab whose proxy failed (events from main always carry it). */
  tabId?: string;
}

export type StartProxyResult = { ok: true; port: number } | { ok: false; error: ProxyErrorInfo };

export interface BreakpointHit {
  /** Unique across tabs (main renumbers the worker's ids). */
  id: number;
  /** The tab whose proxy is holding it. */
  tabId?: string;
  /** 'request' = held before forwarding; 'response' = held before reaching the client. */
  phase: BreakpointPhase;
  /** The request URL and method (for a response hit: the request it answers). */
  url: string;
  method: string;
  /** Request headers for a request hit, response headers for a response hit. */
  headers: Headers;
  body: Uint8Array;
  /** Response hits only. */
  statusCode?: number;
}

export interface BreakpointResume {
  /** Request hits: the (edited) URL and method. Ignored for response hits. */
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array | string;
  /** Response hits: the (edited) status code. */
  statusCode?: number;
}

/** Edits applied to a captured request before it is sent again. */
export interface ReplayOverrides {
  method?: string;
  /** Request path (e.g. /api/users?page=2). */
  url?: string;
  /** Merged into the original headers; a null value deletes that header. */
  headers?: Record<string, string | null>;
  /** Replacement request body. */
  body?: string;
}

export type ReplayResult = { ok: true; trafficId: number } | { ok: false; error: string };

export type HarExportResult =
  { ok: true; path: string; count: number } | { ok: false; canceled?: boolean; error?: string };

export type HarImportResult =
  { ok: true; count: number } | { ok: false; canceled?: boolean; error?: string };

/** Result of running a script against a captured exchange without sending anything. */
export type ScriptTrialOutcome =
  | {
      ok: true;
      before: ScriptTrialExchange;
      after: ScriptTrialExchange;
      /** Plain-language list of what the script changed. */
      changes: string[];
      /** What the script threw (or a timeout), if it failed. */
      error?: string;
      logs: string[];
    }
  | { ok: false; error: string };

/** Validity of the root CA that signs the HTTPS listener's certificate. */
export interface RootCertStatus {
  /** ISO timestamp the root CA stops being valid. */
  notAfter: string;
  /** Whole days left; negative once expired. */
  daysLeft: number;
  expired: boolean;
  /** Within the warning window (or already expired). */
  expiringSoon: boolean;
  /**
   * The stored root's key could not be unlocked, so this session runs on a
   * temporary root that clients do not trust. The stored one is left intact.
   */
  temporary?: boolean;
  temporaryReason?: string;
}

/**
 * The API exposed to the renderer as window.reversee. Proxy, settings,
 * traffic and breakpoint calls act on the active tab (main owns which tab
 * that is); calls naming a request or held exchange by id act on its tab.
 */
export interface RevAPI {
  startProxy(): Promise<StartProxyResult>;
  stopProxy(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** One-time import of pre-2.0 settings persisted in renderer localStorage. */
  migrateLegacySettings(old: unknown): Promise<void>;
  getVersion(): Promise<string>;
  /** The active tab's history as list rows (no bodies; see getTrafficEntry). */
  getTraffic(): Promise<TrafficRow[]>;
  /** One full entry, with bodies and curl, from whichever tab holds it; null once it is gone. */
  getTrafficEntry(trafficId: number): Promise<TrafficEntry | null>;
  clearTraffic(): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
  getBreakpoints(): Promise<BreakpointRule[]>;
  setBreakpoints(rules: BreakpointRule[]): Promise<void>;
  resumeBreakpoint(id: number, params: BreakpointResume): Promise<void>;
  getProtoSpecs(): Promise<ProtoSpecsResult>;
  /** Opens a native file picker for a .proto/.desc file, adds it, returns the new state. */
  importProtoSpec(): Promise<ProtoSpecsResult>;
  removeProtoSpec(id: string): Promise<ProtoSpecsResult>;
  /** Re-sends a captured request (optionally edited) and records the result as a new entry. */
  replayRequest(trafficId: number, overrides?: ReplayOverrides): Promise<ReplayResult>;
  /** Saves captured traffic as a HAR file via a native save dialog. `ids` limits it to those entries. */
  exportHar(ids?: number[]): Promise<HarExportResult>;
  /** Loads a HAR file via a native open dialog and appends its entries to the table. */
  importHar(): Promise<HarImportResult>;
  /** Saves captured exchanges as mock rules (all traffic, or just `ids`). */
  recordMocks(ids?: number[], options?: RecordOptions): Promise<RecordMocksResult>;
  /** What recordMocks would do with the same arguments, without saving (mock bodies left out). */
  previewMocks(ids?: number[], options?: RecordOptions): Promise<RecordMocksResult>;
  getCertStatus(): Promise<RootCertStatus>;
  /** Asks for confirmation, then replaces the root CA. Resolves with the resulting status. */
  regenerateRootCert(): Promise<RootCertStatus>;
  /** Native file picker for a PEM file; resolves with the chosen path or null. */
  pickFile(title: string): Promise<string | null>;
  /** Dry-runs script code against a captured exchange; nothing is sent or saved. */
  tryScript(kind: ScriptKind, code: string, trafficId: number): Promise<ScriptTrialOutcome>;
  /** A new or updated exchange in the active tab, as a list row (no bodies). */
  onTraffic(cb: (row: TrafficRow) => void): () => void;
  /** The active tab's traffic was cleared (the payload is its tab id). */
  onTrafficCleared(cb: (tabId?: string) => void): () => void;
  onBreakpointHit(cb: (hit: BreakpointHit) => void): () => void;
  onBreakpointErrors(cb: (errors: BreakpointCompileError[]) => void): () => void;
  onOpenBreakpoints(cb: () => void): () => void;
  onOpenConnectAi(cb: () => void): () => void;
  onOpenProtoSpecs(cb: () => void): () => void;
  /** A held request/response was resumed (by the UI or by an agent). */
  onBreakpointResumed(cb: (id: number) => void): () => void;
  /** The breakpoint rules changed outside this window (e.g. over MCP). */
  onBreakpointsChanged(cb: (rules: BreakpointRule[]) => void): () => void;
  onCertStatus(cb: (status: RootCertStatus) => void): () => void;
  onOpenPreferences(cb: () => void): () => void;
  onOpenRules(cb: () => void): () => void;
  onOpenScripts(cb: () => void): () => void;
  onFocusFilter(cb: () => void): () => void;
  onToggleProxy(cb: () => void): () => void;
  onProxyState(cb: (state: ProxyState) => void): () => void;
  onProxyError(cb: (error: ProxyErrorInfo) => void): () => void;
  onSettingsChanged(cb: (settings: AppSettings) => void): () => void;
  /** Running state of the active tab's proxy. */
  getProxyState(): Promise<ProxyState>;
  /** Requests/responses the active tab holds at a breakpoint. */
  getHeldHits(): Promise<BreakpointHit[]>;
  getTabs(): Promise<TabsSnapshot>;
  /** Opens a new tab (a copy of `duplicateOf` when given) and makes it active. */
  createTab(duplicateOf?: string): Promise<TabResult>;
  /** Closes a tab, asking first when its proxy is running. Resolves false if kept. */
  closeTab(tabId: string): Promise<boolean>;
  /** Names a tab; an empty name restores the automatic one. Names are unique. */
  renameTab(tabId: string, name: string): Promise<TabResult>;
  moveTab(tabId: string, toIndex: number): Promise<void>;
  setActiveTab(tabId: string): Promise<void>;
  onTabsChanged(cb: (snapshot: TabsSnapshot) => void): () => void;
  /** The menu asked to rename the active tab. */
  onRenameTab(cb: () => void): () => void;
}

// ---- main <-> proxy worker (utilityProcess) ----

export type WorkerInbound =
  | { type: 'start'; settings: ProxySettings; sslOptions?: { key: string; cert: string } }
  | { type: 'stop' }
  | { type: 'set-breakpoints'; rules: BreakpointRule[] }
  | { type: 'set-rules'; rules: RuleSet }
  | { type: 'set-scripts'; scripts: ScriptSet }
  | { type: 'try-script'; id: number; input: ScriptTrialInput }
  | { type: 'resume-breakpoint'; id: number; params: BreakpointResume }
  // Answer to 'cert-request': a certificate for the host, or why there is none.
  | { type: 'cert-reply'; id: number; cert?: { key: string; cert: string }; error?: string }
  | { type: 'set-proto-specs'; bundle: GrpcProtoBundle };

export type WorkerOutbound =
  | { type: 'started'; port: number }
  | { type: 'stopped' }
  // streamId correlates repeated notifies for one long-lived call (gRPC
  // streaming) so main updates the same entry in place instead of appending a
  // new row per frame. Absent for one-shot HTTP/1.1 entries.
  | { type: 'traffic'; entry: TrafficEntry; streamId?: string }
  | { type: 'server-error'; error: ProxyErrorInfo }
  | { type: 'breakpoint-hit'; hit: BreakpointHit }
  | { type: 'script-result'; id: number; result: ScriptTrialResult }
  // Capture anything: the worker needs a certificate for an HTTPS host. The CA
  // key never leaves the main process.
  | { type: 'cert-request'; id: number; host: string }
  | { type: 'breakpoint-errors'; errors: BreakpointCompileError[] };
