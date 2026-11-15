// The listening server around the proxy core. Collects the request body, lets
// an optional gate hold the request (breakpoints), then hands off to
// handleRequest; WebSocket upgrades are tunnelled by handleUpgrade. Replaces
// the http-shutdown dependency with node's native closeAllConnections.
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { handleRequest, type ProxyContext, type ResponseGate } from './proxy';
import { compileRules } from './rules';
import { handleUpgrade } from './websocket';
import { answerPlainHttpOnTls } from './tls-hint';
import type {
  Logger,
  ProxySettings,
  RequestParams,
  RuleSet,
  TrafficEntry,
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
export type RequestGate = (
  request: http.IncomingMessage,
  body: Buffer
) => Promise<RequestParams> | null;

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
}

export interface ProxyServer {
  /** Resolves with the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
  readonly listening: boolean;
  /** Swaps the route and mock rules without restarting the listener. */
  setRules(rules: RuleSet): void;
}

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** The HTTP/1.1 request + upgrade handlers, shared by the plain and the gRPC-mode listeners. */
export interface Http1Handlers {
  onRequest(request: http.IncomingMessage, response: http.ServerResponse): void;
  onUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Destroys every open WebSocket tunnel (they outlive closeAllConnections). */
  closeTunnels(): void;
  setRules(rules: RuleSet): void;
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

  return {
    onRequest(request, response) {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        const halted = gate?.(request, body) ?? null;
        if (halted) {
          void halted.then((requestParams) => handleRequest(request, response, ctx, requestParams));
        } else {
          handleRequest(request, response, ctx, { body });
        }
      });
    },
    onUpgrade(request, socket, head) {
      handleUpgrade(request, socket, head, ctx, tunnels);
    },
    closeTunnels() {
      for (const socket of tunnels) socket.destroy();
      tunnels.clear();
    },
    setRules(rules) {
      // Requests already in flight keep the rule they matched.
      ctx.rules = compileRules(rules, logger);
    },
  };
}

export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  const { settings } = options;
  const logger = options.logger ?? noop;
  const handlers = createHttp1Handlers(options);

  const server =
    settings.listenProtocol === 'https'
      ? https.createServer(
          { key: options.sslOptions?.key, cert: options.sslOptions?.cert },
          handlers.onRequest
        )
      : http.createServer(handlers.onRequest);
  server.on('upgrade', handlers.onUpgrade);
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
        server.listen(settings.listenPort, () => {
          server.removeListener('error', reject);
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : settings.listenPort;
          logger.info(`proxy listening on ${settings.listenProtocol}://localhost:${port}`);
          resolve(port);
        });
      });
    },
    setRules: handlers.setRules,
    close(): Promise<void> {
      return new Promise((resolve) => {
        handlers.closeTunnels();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
