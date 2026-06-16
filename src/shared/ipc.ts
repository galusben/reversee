// IPC contracts: renderer <-> main channels (exposed through the preload
// bridge) and main <-> proxy utilityProcess messages. Channel names follow
// domain:action. This module must stay platform-neutral.
import type { AppSettings } from './settings-schema';
import type {
  BreakpointCompileError,
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
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array;
}

export interface BreakpointResume {
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array | string;
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
  onTraffic(cb: (entry: TrafficEntry) => void): () => void;
  onTrafficCleared(cb: () => void): () => void;
  onBreakpointHit(cb: (hit: BreakpointHit) => void): () => void;
  onBreakpointErrors(cb: (errors: BreakpointCompileError[]) => void): () => void;
  onOpenBreakpoints(cb: () => void): () => void;
  onOpenConnectAi(cb: () => void): () => void;
  onOpenProtoSpecs(cb: () => void): () => void;
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
  | { type: 'traffic'; entry: TrafficEntry }
  | { type: 'server-error'; error: ProxyErrorInfo }
  | { type: 'breakpoint-hit'; hit: BreakpointHit }
  | { type: 'breakpoint-errors'; errors: BreakpointCompileError[] };
