// utilityProcess entry point: runs the proxy server out of the main process
// so a wedged user interceptor or a proxy crash never takes down the app, and
// restart is a cheap kill+respawn. Speaks typed messages with main over
// process.parentPort.
import { createProxyServer, type ProxyServer } from './core/server';
import { createHttp2ProxyServer } from './core/http2';
import { compileBreakpoints, matchBreakpoint, type CompiledBreakpoint } from './core/breakpoints';
import { GrpcRegistry } from './core/grpc-registry';
import type { RequestGate } from './core/server';
import type { ResponseEdit, ResponseGate } from './core/proxy';
import type { WorkerInbound, WorkerOutbound, BreakpointResume } from '../shared/ipc';
import type { Logger, RequestParams, TrafficEntry } from '../shared/types';

// Electron's utilityProcess parentPort; typed loosely to keep this file free
// of the electron module (it must be bundleable as a plain node entry).
const parentPort = (
  process as unknown as {
    parentPort: {
      postMessage(message: unknown): void;
      on(event: 'message', listener: (e: { data: unknown }) => void): void;
    };
  }
).parentPort;

const logger: Logger = {
  debug: (...args) => console.debug('[proxy]', ...args),
  info: (...args) => console.info('[proxy]', ...args),
  warn: (...args) => console.warn('[proxy]', ...args),
  error: (...args) => console.error('[proxy]', ...args),
};

function send(message: WorkerOutbound): void {
  parentPort.postMessage(message);
}

let server: ProxyServer | null = null;
let breakpoints: CompiledBreakpoint[] = [];
// Holds the compiled proto specs used to decode gRPC traffic.
let grpcRegistry: GrpcRegistry | null = null;
let nextHitId = 0;
// Held exchanges by hit id. Requests resolve with the params to forward,
// responses with the edit to apply before the client sees them.
const haltedRequests = new Map<number, (params: RequestParams) => void>();
const haltedResponses = new Map<number, (edit: ResponseEdit) => void>();

const gate: RequestGate = (request, body) => {
  const match = matchBreakpoint(breakpoints, request.url ?? '', request.method ?? '', 'request');
  if (!match) return null;
  const id = nextHitId++;
  return new Promise<RequestParams>((resolve) => {
    haltedRequests.set(id, resolve);
    send({
      type: 'breakpoint-hit',
      hit: {
        id,
        phase: 'request',
        url: request.url ?? '',
        method: request.method ?? '',
        headers: { ...request.headers },
        body,
      },
    });
  });
};

const responseGate: ResponseGate = {
  matches: ({ url, method }) => matchBreakpoint(breakpoints, url, method, 'response') !== null,
  hold: ({ url, method }, response) => {
    const id = nextHitId++;
    return new Promise<ResponseEdit>((resolve) => {
      haltedResponses.set(id, resolve);
      send({
        type: 'breakpoint-hit',
        hit: {
          id,
          phase: 'response',
          url,
          method,
          statusCode: response.statusCode,
          headers: { ...response.headers },
          body: response.body,
        },
      });
    });
  },
};

/** Closing the server drops every held connection, so their hits are void. */
function dropHeld(): void {
  haltedRequests.clear();
  haltedResponses.clear();
}

async function start(msg: Extract<WorkerInbound, { type: 'start' }>): Promise<void> {
  if (server) {
    await server.close();
    server = null;
    dropHeld();
  }
  const onServerError = (err: NodeJS.ErrnoException): void =>
    send({ type: 'server-error', error: { code: err.code, message: err.message } });
  const notify = (entry: TrafficEntry, streamId?: string): void =>
    send({ type: 'traffic', entry, streamId });

  // gRPC needs HTTP/2 + trailers, which the HTTP/1.1 server can't do. When
  // enabled we run the HTTP/2 server (which still serves HTTP/1.1 clients on
  // the same port) and inject the proto registry so captured gRPC frames decode.
  const common = {
    settings: msg.settings,
    sslOptions: msg.sslOptions,
    notify,
    gate,
    responseGate,
    logger,
    onServerError,
  };
  const next = msg.settings.enableGrpc
    ? createHttp2ProxyServer({ ...common, resolveMethod: (path) => grpcRegistry?.resolve(path) })
    : createProxyServer(common);
  const port = await next.listen();
  server = next;
  send({ type: 'started', port });
}

async function stop(): Promise<void> {
  if (server) {
    await server.close();
    server = null;
    dropHeld();
  }
  send({ type: 'stopped' });
}

function resume(id: number, params: BreakpointResume): void {
  const body = typeof params.body === 'string' ? Buffer.from(params.body) : params.body;

  const releaseRequest = haltedRequests.get(id);
  if (releaseRequest) {
    haltedRequests.delete(id);
    releaseRequest({ path: params.url, method: params.method, headers: params.headers, body });
    return;
  }
  const releaseResponse = haltedResponses.get(id);
  if (releaseResponse) {
    haltedResponses.delete(id);
    releaseResponse({ statusCode: params.statusCode, headers: params.headers, body });
  }
}

parentPort.on('message', (e) => {
  const msg = e.data as WorkerInbound;
  switch (msg.type) {
    case 'start':
      start(msg).catch((err: NodeJS.ErrnoException) => {
        logger.error('failed to start proxy', err);
        send({ type: 'server-error', error: { code: err.code, message: err.message } });
      });
      break;
    case 'stop':
      void stop();
      break;
    case 'set-breakpoints': {
      const { compiled, errors } = compileBreakpoints(msg.rules);
      breakpoints = compiled;
      if (errors.length) send({ type: 'breakpoint-errors', errors });
      break;
    }
    case 'resume-breakpoint':
      resume(msg.id, msg.params);
      break;
    case 'set-proto-specs':
      grpcRegistry = new GrpcRegistry(msg.bundle);
      logger.info(`gRPC proto specs loaded: ${grpcRegistry.methodCount} method(s)`);
      break;
  }
});
