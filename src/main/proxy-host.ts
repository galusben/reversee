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
  TrafficEntry,
} from '../shared/types';

export interface ProxyHostEvents {
  onTraffic(entry: TrafficEntry): void;
  onStateChanged(running: boolean, port?: number): void;
  onServerError(error: ProxyErrorInfo): void;
  onBreakpointHit(hit: BreakpointHit): void;
  onBreakpointErrors(errors: BreakpointCompileError[]): void;
}

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
        this.events.onTraffic(msg.entry);
        break;
      case 'server-error':
        this.pendingStart?.reject(msg.error);
        this.pendingStart = null;
        this.events.onServerError(msg.error);
        break;
      case 'breakpoint-hit':
        this.events.onBreakpointHit(msg.hit);
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

  setProtoSpecs(bundle: GrpcProtoBundle): void {
    this.protoBundle = bundle;
    if (this.proc) this.send({ type: 'set-proto-specs', bundle });
  }

  resumeBreakpoint(id: number, params: BreakpointResume): void {
    if (this.proc) this.send({ type: 'resume-breakpoint', id, params });
  }

  kill(): void {
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
