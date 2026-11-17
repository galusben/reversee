// One tab's proxy session: its own proxy worker (a utilityProcess, so a wedged
// interceptor or a crash takes down only this tab), traffic history,
// breakpoint rules and held exchanges. The SessionManager owns every session
// and the resources they share (certificates, proto specs, id counters).
import log from 'electron-log';
import { ProxyHost, type ProxyHostEvents } from './proxy-host';
import { TrafficStore } from './traffic-store';
import { getSettings } from './settings';
import { readClientCert } from './client-cert';
import { toProxySettings, type AppSettings } from '../shared/settings-schema';
import type {
  BreakpointHit,
  BreakpointResume,
  ProxyErrorInfo,
  StartProxyResult,
} from '../shared/ipc';
import type {
  BreakpointCompileError,
  BreakpointRule,
  GrpcProtoBundle,
  TrafficEntry,
} from '../shared/types';

/** Where a session reports what happens in it (the manager fans this out). */
export interface SessionSink {
  traffic(session: Session, entry: TrafficEntry): void;
  trafficCleared(session: Session): void;
  state(session: Session): void;
  error(session: Session, error: ProxyErrorInfo): void;
  breakpointHit(session: Session, hit: BreakpointHit): void;
  breakpointResumed(session: Session, id: number): void;
  breakpointsChanged(session: Session, rules: BreakpointRule[]): void;
  breakpointErrors(session: Session, errors: BreakpointCompileError[]): void;
}

/** The subset of ProxyHost a session drives (a fake stands in for it in tests). */
export type SessionProxyHost = Pick<
  ProxyHost,
  | 'isRunning'
  | 'start'
  | 'stop'
  | 'restart'
  | 'kill'
  | 'setBreakpoints'
  | 'setRules'
  | 'setScripts'
  | 'setProtoSpecs'
  | 'resumeBreakpoint'
  | 'tryScript'
>;

export interface SessionDeps {
  sink: SessionSink;
  /** Shared across tabs so a trafficId names one request on its own. */
  allocateTrafficId(): number;
  /** Shared across tabs so a held-request id names one exchange on its own. */
  allocateHitId(): number;
  /** The listener certificate for an HTTPS listen protocol. */
  getLeafCert(): { key: string; cert: string } | undefined;
  /** Capture anything: a certificate for an HTTPS host, signed by the root CA. */
  issueCert(host: string): { key: string; cert: string };
  /** Another running tab already listening on `port`, if any. */
  portOwner(port: number, exceptTabId: string): { id: string; name: string } | undefined;
  protoBundle(): GrpcProtoBundle | null;
  createProxyHost?(events: ProxyHostEvents): SessionProxyHost;
}

export class Session {
  readonly proxyHost: SessionProxyHost;
  readonly trafficStore: TrafficStore;
  private running = false;
  private port: number | undefined;
  private lastError: string | undefined;
  private breakpointRules: BreakpointRule[] = [];
  /** Held exchanges by their (cross-tab) id, with the worker's own id. */
  private held = new Map<number, { hit: BreakpointHit; workerId: number }>();
  // Correlates a worker streamId to the trafficId main assigned, so the
  // repeated notifies of one exchange update the same entry instead of
  // appending. Only in-flight exchanges are tracked.
  private streamToTrafficId = new Map<string, number>();

  constructor(
    readonly id: string,
    private deps: SessionDeps
  ) {
    this.trafficStore = new TrafficStore(getSettings(id).trafficCap, deps.allocateTrafficId);
    const events: ProxyHostEvents = {
      onTraffic: (entry, streamId) => this.recordTraffic(entry, streamId),
      onStateChanged: (running, port) => {
        this.running = running;
        this.port = running ? port : undefined;
        if (running) this.lastError = undefined;
        else {
          // Stopping closes every held connection; their hits are void.
          this.held.clear();
          this.settlePendingTraffic();
        }
        deps.sink.state(this);
      },
      onServerError: (error) => {
        this.lastError = error.message;
        deps.sink.error(this, { ...error, tabId: this.id });
        deps.sink.state(this);
      },
      onBreakpointHit: (hit) => {
        const tagged = { ...hit, id: deps.allocateHitId(), tabId: this.id };
        this.held.set(tagged.id, { hit: tagged, workerId: hit.id });
        deps.sink.breakpointHit(this, tagged);
      },
      onBreakpointErrors: (errors) => {
        log.warn(`invalid breakpoint patterns (tab ${this.id})`, errors);
        deps.sink.breakpointErrors(this, errors);
      },
      issueCert: (host) => deps.issueCert(host),
    };
    this.proxyHost = deps.createProxyHost ? deps.createProxyHost(events) : new ProxyHost(events);
    const bundle = deps.protoBundle();
    if (bundle) this.proxyHost.setProtoSpecs(bundle);
  }

  get settings(): AppSettings {
    return getSettings(this.id);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get boundPort(): number | undefined {
    return this.port;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  get heldHits(): BreakpointHit[] {
    return [...this.held.values()].map((h) => h.hit);
  }

  get rules(): BreakpointRule[] {
    return this.breakpointRules;
  }

  /**
   * Store an entry and report it. With a `streamId` (an exchange the worker
   * reports more than once: pending, streaming, gRPC, WebSocket) the first
   * notify appends a new entry and later ones update it in place; without one
   * (replays, imports) it always appends.
   */
  recordTraffic(entry: TrafficEntry, streamId?: string): TrafficEntry {
    entry.tabId = this.id;
    if (streamId !== undefined) {
      const existing = this.streamToTrafficId.get(streamId);
      if (existing !== undefined) {
        entry.trafficId = existing;
        if (!entry.pending) this.streamToTrafficId.delete(streamId);
        const updated = this.trafficStore.update(entry);
        // An evicted or cleared entry is not resurrected by a late update.
        if (updated) this.deps.sink.traffic(this, updated);
        return updated ?? entry;
      }
    }
    const stored = this.trafficStore.add(entry);
    if (streamId !== undefined && entry.pending) {
      this.streamToTrafficId.set(streamId, stored.trafficId);
    }
    this.deps.sink.traffic(this, stored);
    return stored;
  }

  /**
   * The proxy went away (stopped, killed, crashed): nothing will complete the
   * exchanges still marked in flight, so settle them instead of leaving rows
   * that look like they are loading forever.
   */
  private settlePendingTraffic(): void {
    this.streamToTrafficId.clear();
    for (const entry of this.trafficStore.getAll()) {
      if (!entry.pending) continue;
      delete entry.pending;
      if (entry.ws) entry.ws.closed = true;
      else if (entry.response.statusCode === undefined) {
        entry.connectorError ??= 'the proxy stopped before a response arrived';
      }
      this.deps.sink.traffic(this, entry);
    }
  }

  clearTraffic(): void {
    this.trafficStore.clear();
    this.streamToTrafficId.clear();
    this.deps.sink.trafficCleared(this);
  }

  async start(): Promise<StartProxyResult> {
    const settings = this.settings;
    if (!settings.dest && !settings.captureAll) {
      return { ok: false, error: { message: 'Destination host is required' } };
    }
    const owner = this.deps.portOwner(settings.listenPort, this.id);
    if (owner) {
      const error = {
        code: 'EADDRINUSE',
        message: `Port ${settings.listenPort} is already used by the tab "${owner.name}" (${owner.id}). Choose another listen port.`,
      };
      this.lastError = error.message;
      this.deps.sink.state(this);
      return { ok: false, error };
    }
    try {
      const leaf = this.deps.getLeafCert();
      const sslOptions =
        settings.listenProtocol === 'https' && !settings.captureAll && leaf ? leaf : undefined;
      const port = await this.proxyHost.start({
        settings: toProxySettings(settings, readClientCert(settings)),
        sslOptions,
      });
      return { ok: true, port };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { ok: false, error: { code: e.code, message: e.message ?? String(error) } };
    }
  }

  stop(): void {
    this.proxyHost.stop();
  }

  async restart(): Promise<number | null> {
    return this.proxyHost.restart();
  }

  /** Pushes the settings main acts on at once: the history cap, rules and scripts. */
  applySettings(settings: AppSettings = this.settings): void {
    this.trafficStore.setCap(settings.trafficCap);
    // Routes and mocks apply to the running proxy at once; no restart needed.
    this.proxyHost.setRules({ routes: settings.routes, mocks: settings.mocks });
    // So do the interceptor scripts.
    this.proxyHost.setScripts({
      interceptRequest: settings.interceptRequest,
      requestInterceptor: settings.requestInterceptor,
      interceptResponse: settings.interceptResponse,
      responseInterceptor: settings.responseInterceptor,
    });
  }

  setBreakpointRules(rules: BreakpointRule[]): void {
    this.breakpointRules = rules;
    this.proxyHost.setBreakpoints(rules);
    this.deps.sink.breakpointsChanged(this, rules);
  }

  /** Releases a held exchange by its (cross-tab) id. Returns false if it is not held here. */
  resumeHeld(id: number, params: BreakpointResume): boolean {
    const held = this.held.get(id);
    if (!held) return false;
    this.proxyHost.resumeBreakpoint(held.workerId, params);
    this.held.delete(id);
    this.deps.sink.breakpointResumed(this, id);
    return true;
  }

  holds(id: number): boolean {
    return this.held.has(id);
  }

  setProtoSpecs(bundle: GrpcProtoBundle): void {
    this.proxyHost.setProtoSpecs(bundle);
  }

  /** Stops the worker for good (tab closed, app quitting). */
  dispose(): void {
    this.proxyHost.kill();
    this.held.clear();
    this.streamToTrafficId.clear();
  }
}
