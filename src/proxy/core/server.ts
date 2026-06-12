// The listening server around the proxy core. Collects the request body, lets
// an optional gate hold the request (breakpoints), then hands off to
// handleRequest. Replaces the http-shutdown dependency with node's native
// closeAllConnections.
import http from 'node:http';
import https from 'node:https';
import { handleRequest } from './proxy';
import type { Logger, ProxySettings, RequestParams, TrafficEntry } from '../../shared/types';

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
  notify: (entry: TrafficEntry) => void;
  sslOptions?: SslOptions;
  gate?: RequestGate;
  logger?: Logger;
  /** Runtime server errors (e.g. EADDRINUSE) after listen succeeded. */
  onServerError?: (err: NodeJS.ErrnoException) => void;
}

export interface ProxyServer {
  /** Resolves with the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
  readonly listening: boolean;
}

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  const { settings, notify, gate } = options;
  const logger = options.logger ?? noop;

  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const halted = gate?.(request, body) ?? null;
      if (halted) {
        void halted.then((requestParams) =>
          handleRequest(request, response, settings, notify, requestParams, logger)
        );
      } else {
        handleRequest(request, response, settings, notify, { body }, logger);
      }
    });
  };

  const server =
    settings.listenProtocol === 'https'
      ? https.createServer(
          { key: options.sslOptions?.key, cert: options.sslOptions?.cert },
          handler
        )
      : http.createServer(handler);

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
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
