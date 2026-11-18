// The listening server around the proxy core. Streams the request body
// straight through when nothing needs it whole; otherwise collects it (up to a
// ceiling, then 413), lets an optional gate hold the request (breakpoints),
// then hands off to handleRequest; WebSocket upgrades are tunnelled by
// handleUpgrade. Replaces the http-shutdown dependency with node's native
// closeAllConnections.
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import {
  handleRequest,
  MAX_BUFFERED_REQUEST_BODY,
  requestNeedsBuffering,
  type ProxyContext,
  type ResponseGate,
} from './proxy';
import { CAPTURE_LIMIT } from './capture';
import { compileRules } from './rules';
import { handleUpgrade } from './websocket';
import { answerPlainHttpOnTls } from './tls-hint';
import { connectDisabledResponse, createForwardProxy, type IssueCert } from './forward';
import type {
  Logger,
  ProxySettings,
  RequestParams,
  RuleSet,
  ScriptSet,
  TrafficEntry,
  UpstreamTarget,
} from '../../shared/types';

export interface SslOptions {
  key: string | Buffer;
  cert: string | Buffer;
}

/**
 * Inspects a fully-buffered incoming request. Return null to proxy it
 * immediately, or a promise of (possibly edited) request params to hold it
 * until the promise resolves (breakpoint resume).
 */
export type RequestGate = ((
  request: http.IncomingMessage,
  body: Buffer
) => Promise<RequestParams> | null) & {
  /**
   * Whether the gate may hold this request, asked before its body is read. A
   * request it will not hold is streamed upstream instead of buffered. Without
   * it every request is buffered for the gate.
   */
  matches?: (request: http.IncomingMessage) => boolean;
};

export interface ProxyServerOptions {
  settings: ProxySettings;
  /** streamId correlates the repeated notifies of one exchange (see ProxyContext). */
  notify: (entry: TrafficEntry, streamId?: string) => void;
  sslOptions?: SslOptions;
  gate?: RequestGate;
  /** Response breakpoints. */
  responseGate?: ResponseGate;
  logger?: Logger;
  /** Runtime server errors (e.g. EADDRINUSE) after listen succeeded. */
  onServerError?: (err: NodeJS.ErrnoException) => void;
  /** Bytes of each response body kept for the traffic view. */
  captureLimit?: number;
  /**
   * The most request body held in memory when it must be buffered (a request
   * breakpoint or interceptor); past it the client gets a 413. Defaults to
   * MAX_BUFFERED_REQUEST_BODY.
   */
  maxBufferedBody?: number;
  /**
   * Capture-anything mode: issues the certificate presented to a client for an
   * HTTPS host. Without it HTTPS tunnels pass through undecrypted.
   */
  issueCert?: IssueCert;
}

export interface ProxyServer {
  /** Resolves with the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
  readonly listening: boolean;
  /** Swaps the route and mock rules without restarting the listener. */
  setRules(rules: RuleSet): void;
  /** Swaps the interceptor scripts; requests already in flight keep the old ones. */
  setScripts(scripts: ScriptSet): void;
}

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** The HTTP/1.1 request + upgrade handlers, shared by the plain and the gRPC-mode listeners. */
export interface Http1Handlers {
  /** `forward` is the server the client asked for, in capture-anything mode. */
  onRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    forward?: UpstreamTarget
  ): void;
  onUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    forward?: UpstreamTarget
  ): void;
  /** Destroys every open WebSocket tunnel (they outlive closeAllConnections). */
  closeTunnels(): void;
  setRules(rules: RuleSet): void;
  /** Swaps the interceptor scripts; requests already in flight keep the old ones. */
  setScripts(scripts: ScriptSet): void;
}

export function createHttp1Handlers(options: ProxyServerOptions): Http1Handlers {
  const { settings, gate } = options;
  const logger = options.logger ?? noop;
  const ctx: ProxyContext = {
    settings,
    notify: options.notify,
    rules: compileRules(settings, logger),
    responseGate: options.responseGate,
    logger,
    captureLimit: options.captureLimit,
  };
  const tunnels = new Set<Duplex>();
  const maxBody = options.maxBufferedBody ?? MAX_BUFFERED_REQUEST_BODY;
  const captureLimit = options.captureLimit ?? CAPTURE_LIMIT;

  return {
    onRequest(request, response, forward) {
      const mayHold = gate ? (gate.matches?.(request) ?? true) : false;
      if (!mayHold && !requestNeedsBuffering(ctx)) {
        handleRequest(request, response, ctx, {}, forward, { stream: true });
        return;
      }

      // Buffered, so bounded: a body that cannot fit is refused with a 413
      // (upfront when its content-length already says so).
      const declared = Number(request.headers['content-length']);
      if (declared > maxBody) {
        handleRequest(request, response, ctx, { body: Buffer.alloc(0) }, forward, {
          tooLarge: { limit: maxBody, size: declared },
        });
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let refused = false;
      request.on('data', (chunk: Buffer) => {
        if (refused) return;
        received += chunk.length;
        if (received > maxBody) {
          refused = true;
          // Only the start is kept, for the traffic view.
          const head = Buffer.concat(chunks, Math.min(received - chunk.length, captureLimit));
          chunks.length = 0;
          handleRequest(request, response, ctx, { body: head }, forward, {
            tooLarge: { limit: maxBody, size: received },
          });
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (refused) return;
        const body = Buffer.concat(chunks);
        const halted = gate?.(request, body) ?? null;
        if (halted) {
          void halted.then((requestParams) =>
            handleRequest(request, response, ctx, requestParams, forward)
          );
        } else {
          handleRequest(request, response, ctx, { body }, forward);
        }
      });
    },
    onUpgrade(request, socket, head, forward) {
      handleUpgrade(request, socket, head, ctx, tunnels, forward);
    },
    closeTunnels() {
      for (const socket of tunnels) socket.destroy();
      tunnels.clear();
    },
    setRules(rules) {
      // Requests already in flight keep the rule they matched.
      ctx.rules = compileRules(rules, logger);
    },
    setScripts(scripts) {
      // A new object, so a request that already read ctx.settings is unaffected.
      ctx.settings = { ...ctx.settings, ...scripts };
    },
  };
}

export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  const { settings } = options;
  const logger = options.logger ?? noop;
  const handlers = createHttp1Handlers(options);

  let boundPort: number | undefined;
  const forward = settings.captureAll
    ? createForwardProxy({
        handlers,
        issueCert: options.issueCert,
        notify: options.notify,
        logger,
        listenPort: () => boundPort,
      })
    : null;
  const onRequest: http.RequestListener = forward
    ? forward.onRequest
    : (request, response) => handlers.onRequest(request, response);

  const server =
    settings.listenProtocol === 'https'
      ? https.createServer(
          { key: options.sslOptions?.key, cert: options.sslOptions?.cert },
          onRequest
        )
      : http.createServer(onRequest);
  server.on('upgrade', (request, socket, head) =>
    forward ? forward.onUpgrade(request, socket, head) : handlers.onUpgrade(request, socket, head)
  );
  // A client using the listener as its proxy while it forwards to one server
  // gets told how to switch, instead of a silent hang-up.
  server.on('connect', (request, socket, head) => {
    if (forward) forward.onConnect(request, socket, head);
    else socket.end(connectDisabledResponse());
  });
  if (server instanceof https.Server) answerPlainHttpOnTls(server);

  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error('proxy server error', err);
    options.onServerError?.(err);
  });

  return {
    get listening(): boolean {
      return server.listening;
    },
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        const onListening = (): void => {
          server.removeListener('error', reject);
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : settings.listenPort;
          boundPort = port;
          logger.info(`proxy listening on ${settings.listenProtocol}://localhost:${port}`);
          resolve(port);
        };
        // An open proxy that decrypts HTTPS must not be reachable from the
        // network: capture-anything mode listens on this machine only.
        if (settings.captureAll) server.listen(settings.listenPort, '127.0.0.1', onListening);
        else server.listen(settings.listenPort, onListening);
      });
    },
    setRules: handlers.setRules,
    setScripts: handlers.setScripts,
    close(): Promise<void> {
      return new Promise((resolve) => {
        handlers.closeTunnels();
        forward?.close();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
