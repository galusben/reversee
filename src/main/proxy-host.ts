// Owns the proxy utilityProcess: spawn, message routing, restart, teardown.
import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import log from 'electron-log';
import type {
  BreakpointHit,
  BreakpointResume,
  ProxyErrorInfo,
  WorkerInbound,
  WorkerOutbound,
} from '../shared/ipc';
import type {
  BreakpointCompileError,
  BreakpointRule,
  GrpcProtoBundle,
  ProxySettings,
  RuleSet,
  ScriptSet,
  ScriptTrialInput,
  ScriptTrialResult,
  TrafficEntry,
} from '../shared/types';

export interface ProxyHostEvents {
  onTraffic(entry: TrafficEntry, streamId?: string): void;
  onStateChanged(running: boolean, port?: number): void;
  onServerError(error: ProxyErrorInfo): void;
  onBreakpointHit(hit: BreakpointHit): void;
  onBreakpointErrors(errors: BreakpointCompileError[]): void;
  /** Capture anything: a certificate for an HTTPS host, signed by the root CA. */
  issueCert(host: string): { key: string; cert: string };
}

/** A script gets 1 s; the rest is headroom for a worker that has to spawn first. */
const TRIAL_TIMEOUT_MS = 10_000;

interface StartArgs {
  settings: ProxySettings;
  sslOptions?: { key: string; cert: string };
}

export class ProxyHost {
  private proc: UtilityProcess | null = null;
  private running = false;
  private breakpointRules: BreakpointRule[] = [];
  private protoBundle: GrpcProtoBundle | null = null;
  private lastStart: StartArgs | null = null;
  private pendingStart: { resolve(port: number): void; reject(err: ProxyErrorInfo): void } | null =
    null;

  private nextTrialId = 0;
  private trials = new Map<
    number,
    { resolve(result: ScriptTrialResult): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();

  constructor(private events: ProxyHostEvents) {}

  get isRunning(): boolean {
    return this.running;
  }

  private ensureProcess(): UtilityProcess {
    if (this.proc) return this.proc;
    const workerPath = path.join(import.meta.dirname, 'proxyWorker.js');
    const proc = utilityProcess.fork(workerPath, [], { serviceName: 'reversee-proxy' });
    proc.on('message', (msg: WorkerOutbound) => this.onMessage(msg));
    proc.on('exit', (code) => {
      log.warn(`proxy worker exited with code ${code}`);
      this.proc = null;
      if (this.running) {
        this.running = false;
        this.events.onStateChanged(false);
        this.events.onServerError({ message: `proxy process exited unexpectedly (code ${code})` });
      }
      this.pendingStart?.reject({ message: `proxy process exited (code ${code})` });
      this.pendingStart = null;
      this.failTrials('the proxy process exited');
    });
    this.proc = proc;
    this.send({ type: 'set-breakpoints', rules: this.breakpointRules });
    if (this.protoBundle) this.send({ type: 'set-proto-specs', bundle: this.protoBundle });
    return proc;
  }

  private send(message: WorkerInbound): void {
    this.ensureProcess().postMessage(message);
  }

  private onMessage(msg: WorkerOutbound): void {
    switch (msg.type) {
      case 'started':
        this.running = true;
        this.pendingStart?.resolve(msg.port);
        this.pendingStart = null;
        this.events.onStateChanged(true, msg.port);
        break;
      case 'stopped':
        this.running = false;
        this.events.onStateChanged(false);
        break;
      case 'traffic':
        this.events.onTraffic(msg.entry, msg.streamId);
        break;
      case 'server-error':
        this.pendingStart?.reject(msg.error);
        this.pendingStart = null;
        this.events.onServerError(msg.error);
        break;
      case 'breakpoint-hit':
        this.events.onBreakpointHit(msg.hit);
        break;
      case 'script-result': {
        const trial = this.trials.get(msg.id);
        if (trial) {
          clearTimeout(trial.timer);
          this.trials.delete(msg.id);
          trial.resolve(msg.result);
        }
        break;
      }
      case 'cert-request':
        try {
          this.send({ type: 'cert-reply', id: msg.id, cert: this.events.issueCert(msg.host) });
        } catch (err) {
          this.send({ type: 'cert-reply', id: msg.id, error: (err as Error).message });
        }
        break;
      case 'breakpoint-errors':
        this.events.onBreakpointErrors(msg.errors);
        break;
    }
  }

  start(args: StartArgs): Promise<number> {
    this.lastStart = args;
    return new Promise((resolve, reject) => {
      this.pendingStart = { resolve, reject };
      this.send({ type: 'start', settings: args.settings, sslOptions: args.sslOptions });
    });
  }

  stop(): void {
    if (this.proc) this.send({ type: 'stop' });
  }

  /** Kills the worker (recovers from wedged interceptors) and starts again. */
  async restart(): Promise<number | null> {
    this.kill();
    if (!this.lastStart) return null;
    return this.start(this.lastStart);
  }

  setBreakpoints(rules: BreakpointRule[]): void {
    this.breakpointRules = rules;
    if (this.proc) this.send({ type: 'set-breakpoints', rules });
  }

  /** Applies route and mock rules to the running proxy (no-op when stopped). */
  setRules(rules: RuleSet): void {
    if (this.lastStart) {
      this.lastStart.settings = { ...this.lastStart.settings, ...rules };
    }
    if (this.proc && this.running) this.send({ type: 'set-rules', rules });
  }

  /** Applies the interceptor scripts to the running proxy (no-op when stopped). */
  setScripts(scripts: ScriptSet): void {
    if (this.lastStart) {
      this.lastStart.settings = { ...this.lastStart.settings, ...scripts };
    }
    if (this.proc && this.running) this.send({ type: 'set-scripts', scripts });
  }

  /**
   * Dry-runs a script in the worker (never in the main process). Works whether
   * or not the proxy is running; the worker is spawned on demand.
   */
  tryScript(input: ScriptTrialInput): Promise<ScriptTrialResult> {
    return new Promise((resolve, reject) => {
      const id = this.nextTrialId++;
      const timer = setTimeout(() => {
        this.trials.delete(id);
        reject(new Error('the script run did not finish in time'));
      }, TRIAL_TIMEOUT_MS);
      this.trials.set(id, { resolve, reject, timer });
      this.send({ type: 'try-script', id, input });
    });
  }

  private failTrials(reason: string): void {
    for (const trial of this.trials.values()) {
      clearTimeout(trial.timer);
      trial.reject(new Error(reason));
    }
    this.trials.clear();
  }

  setProtoSpecs(bundle: GrpcProtoBundle): void {
    this.protoBundle = bundle;
    if (this.proc) this.send({ type: 'set-proto-specs', bundle });
  }

  resumeBreakpoint(id: number, params: BreakpointResume): void {
    if (this.proc) this.send({ type: 'resume-breakpoint', id, params });
  }

  kill(): void {
    this.failTrials('the proxy process was restarted');
    if (this.proc) {
      this.proc.removeAllListeners('exit');
      this.proc.kill();
      this.proc = null;
    }
    if (this.running) {
      this.running = false;
      this.events.onStateChanged(false);
    }
  }
}
