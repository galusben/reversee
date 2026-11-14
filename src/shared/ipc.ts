// IPC contracts: renderer <-> main channels (exposed through the preload
// bridge) and main <-> proxy utilityProcess messages. Channel names follow
// domain:action. This module must stay platform-neutral.
import type { AppSettings } from './settings-schema';
import type {
  BreakpointCompileError,
  BreakpointPhase,
  BreakpointRule,
  GrpcProtoBundle,
  Headers,
  ProtoSpec,
  ProtoSpecCompileError,
  ProxySettings,
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
  certStatusGet: 'cert:status',
  certRegenerate: 'cert:regenerate',
  filePick: 'file:pick',
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
  focusFilterEvent: 'ui:focus-filter',
  toggleProxyEvent: 'ui:toggle-proxy',
} as const;

/** Saved proto specs plus the latest compile errors, returned after each mutation. */
export interface ProtoSpecsResult {
  specs: ProtoSpec[];
  errors: ProtoSpecCompileError[];
}

export interface ProxyState {
  running: boolean;
  port?: number;
}

export interface ProxyErrorInfo {
  code?: string;
  message: string;
}

export type StartProxyResult = { ok: true; port: number } | { ok: false; error: ProxyErrorInfo };

export interface BreakpointHit {
  id: number;
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

/** The API exposed to the renderer as window.reversee. */
export interface RevAPI {
  startProxy(): Promise<StartProxyResult>;
  stopProxy(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** One-time import of pre-2.0 settings persisted in renderer localStorage. */
  migrateLegacySettings(old: unknown): Promise<void>;
  getVersion(): Promise<string>;
  getTraffic(): Promise<TrafficEntry[]>;
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
  getCertStatus(): Promise<RootCertStatus>;
  /** Asks for confirmation, then replaces the root CA. Resolves with the resulting status. */
  regenerateRootCert(): Promise<RootCertStatus>;
  /** Native file picker for a PEM file; resolves with the chosen path or null. */
  pickFile(title: string): Promise<string | null>;
  onTraffic(cb: (entry: TrafficEntry) => void): () => void;
  onTrafficCleared(cb: () => void): () => void;
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
  onFocusFilter(cb: () => void): () => void;
  onToggleProxy(cb: () => void): () => void;
  onProxyState(cb: (state: ProxyState) => void): () => void;
  onProxyError(cb: (error: ProxyErrorInfo) => void): () => void;
  onSettingsChanged(cb: (settings: AppSettings) => void): () => void;
}

// ---- main <-> proxy worker (utilityProcess) ----

export type WorkerInbound =
  | { type: 'start'; settings: ProxySettings; sslOptions?: { key: string; cert: string } }
  | { type: 'stop' }
  | { type: 'set-breakpoints'; rules: BreakpointRule[] }
  | { type: 'resume-breakpoint'; id: number; params: BreakpointResume }
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
  | { type: 'breakpoint-errors'; errors: BreakpointCompileError[] };
