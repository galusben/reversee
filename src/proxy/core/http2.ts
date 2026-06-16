// HTTP/2 reverse proxy with gRPC awareness. Used instead of the HTTP/1.1
// server (core/server.ts) when `enableGrpc` is set, so native gRPC — which
// requires HTTP/2 framing and trailers — can be proxied and decoded.
//
// For each inbound stream it opens an upstream HTTP/2 stream to the fixed
// destination and pipes bytes both ways UNMODIFIED (the wire is never altered),
// while copying frames through a FrameAccumulator to decode gRPC messages and
// capturing the grpc-status trailer. Works for unary and all streaming modes:
// messages accumulate as DATA frames arrive and the traffic entry is re-emitted
// (the store upserts by trafficId).
//
// Electron-free (node:http2 only). This is an HTTP/2-only listener: https
// negotiates h2 via ALPN, http speaks cleartext h2c (prior knowledge). Plain
// HTTP/1.1 is not served in gRPC mode — mixing the native 'stream' API (needed
// for trailers) with the HTTP/1.1 compatibility layer double-sends trailers.
import http2 from 'node:http2';
import { FrameAccumulator, decodeFrame } from './grpc-frames';
import type { ResolvedMethod } from './grpc-registry';
import type { ProxyServer, SslOptions } from './server';
import type {
  GrpcView,
  Headers,
  Logger,
  ProxySettings,
  RequestView,
  ResponseView,
  Timings,
  TrafficEntry,
} from '../../shared/types';

export interface Http2ProxyServerOptions {
  settings: ProxySettings;
  notify: (entry: TrafficEntry) => void;
  sslOptions?: SslOptions;
  /** Resolves a gRPC `:path` to the message types that decode its frames. */
  resolveMethod?: (path: string) => ResolvedMethod | undefined;
  logger?: Logger;
  onServerError?: (err: NodeJS.ErrnoException) => void;
}

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let trafficId = 0;

/** HTTP/2 headers we manage ourselves and must not copy between streams. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** Copy real (non-pseudo, non-hop-by-hop) headers into our serializable shape. */
function viewHeaders(h: http2.IncomingHttpHeaders | http2.OutgoingHttpHeaders): Headers {
  const out: Headers = {};
  for (const key of Object.keys(h)) {
    if (key.startsWith(':') || HOP_BY_HOP.has(key)) continue;
    out[key] = h[key] as string | string[] | undefined;
  }
  return out;
}

export function createHttp2ProxyServer(options: Http2ProxyServerOptions): ProxyServer {
  const { settings, notify } = options;
  const logger = options.logger ?? noop;
  const rejectUnauthorized = settings.allowSelfSignedUpstream === false;
  const upstreamOrigin = `${settings.destProtocol === 'https' ? 'https' : 'http'}://${settings.dest}:${settings.destPort}`;

  const server =
    settings.listenProtocol === 'https'
      ? http2.createSecureServer({
          key: options.sslOptions?.key,
          cert: options.sslOptions?.cert,
        })
      : http2.createServer();

  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error('http2 proxy server error', err);
    options.onServerError?.(err);
  });

  // HTTP/2 streams (the gRPC path).
  server.on(
    'stream',
    (clientStream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      forwardStream(clientStream, headers, {
        settings,
        notify,
        logger,
        rejectUnauthorized,
        upstreamOrigin,
        resolveMethod: options.resolveMethod,
      });
    }
  );

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
          logger.info(`http2 proxy listening on ${settings.listenProtocol}://localhost:${port}`);
          resolve(port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

interface ForwardContext {
  settings: ProxySettings;
  notify: (entry: TrafficEntry) => void;
  logger: Logger;
  rejectUnauthorized: boolean;
  upstreamOrigin: string;
  resolveMethod?: (path: string) => ResolvedMethod | undefined;
}

function forwardStream(
  clientStream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  ctx: ForwardContext
): void {
  const { settings, notify, logger, resolveMethod } = ctx;
  const startAt = process.hrtime.bigint();
  const timings: Timings = { start: new Date() };

  const path = String(headers[':path'] ?? '');
  const method = String(headers[':method'] ?? 'POST');
  const contentType = String(headers['content-type'] ?? '');
  const isGrpc = contentType.startsWith('application/grpc');
  const resolved = isGrpc ? resolveMethod?.(path) : undefined;

  const requestView: RequestView = {
    url: path,
    method,
    headers: viewHeaders(headers),
    body: Buffer.alloc(0),
    target: { protocol: settings.destProtocol, host: settings.dest, port: settings.destPort },
  };
  const responseView: ResponseView = { headers: {}, body: Buffer.alloc(0) };
  const grpc: GrpcView | undefined = isGrpc
    ? { method: path, requestMessages: [], responseMessages: [], matchedSpecId: resolved?.specId }
    : undefined;
  const entry: TrafficEntry = {
    trafficId: trafficId++,
    request: requestView,
    response: responseView,
    timings,
    grpc,
  };
  notify(entry); // surface the row immediately; re-emitted as frames/trailers arrive

  const session = http2.connect(ctx.upstreamOrigin, { rejectUnauthorized: ctx.rejectUnauthorized });
  session.on('error', (err) => {
    logger.info('grpc upstream error', err);
    entry.connectorError = err;
    responseView.statusCode = 502;
    notify(entry);
    if (!clientStream.closed) clientStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    session.close();
  });

  // Build the upstream request headers: keep gRPC/content headers, drop the
  // inbound pseudo-headers and hop-by-hop, and let http2 set :authority/:scheme.
  const outHeaders: http2.OutgoingHttpHeaders = { ':method': method, ':path': path };
  for (const key of Object.keys(headers)) {
    if (key.startsWith(':') || HOP_BY_HOP.has(key)) continue;
    outHeaders[key] = headers[key];
  }
  const upstream = session.request(outHeaders);

  // --- request direction: client -> upstream (raw passthrough + decode copy) ---
  const reqAcc = new FrameAccumulator();
  const reqRaw: Buffer[] = [];
  clientStream.on('data', (chunk: Buffer) => {
    upstream.write(chunk);
    reqRaw.push(chunk);
    if (grpc) {
      for (const frame of reqAcc.push(chunk)) {
        grpc.requestMessages.push(decodeFrame(frame, resolved?.requestType));
      }
      notify(entry);
    }
  });
  clientStream.on('end', () => {
    upstream.end();
    requestView.body = Buffer.concat(reqRaw);
  });
  clientStream.on('error', (err) => {
    logger.info('grpc client stream error', err);
    if (!upstream.closed) upstream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  });

  // --- response direction: upstream -> client ---
  const respAcc = new FrameAccumulator();
  const respRaw: Buffer[] = [];
  let trailers: Headers = {};

  upstream.on('response', (respHeaders) => {
    timings.firstByte = Number(process.hrtime.bigint() - startAt);
    responseView.statusCode = Number(respHeaders[':status']) || undefined;
    responseView.headers = viewHeaders(respHeaders);

    // gRPC "Trailers-Only": status rides in the response HEADERS (END_STREAM,
    // no DATA). Capture the status and forward the headers as a final frame.
    const trailersOnly = respHeaders['grpc-status'] !== undefined;
    if (grpc && trailersOnly) {
      grpc.status = Number(respHeaders['grpc-status']);
      grpc.statusMessage = grpcMessage(respHeaders['grpc-message']);
    }

    if (clientStream.closed) return;
    clientStream.respond(downstreamHeaders(respHeaders), { waitForTrailers: !trailersOnly });
    notify(entry);
  });

  clientStream.on('wantTrailers', () => {
    clientStream.sendTrailers(trailers as http2.OutgoingHttpHeaders);
  });

  upstream.on('data', (chunk: Buffer) => {
    if (!clientStream.closed) clientStream.write(chunk);
    respRaw.push(chunk);
    if (grpc) {
      for (const frame of respAcc.push(chunk)) {
        grpc.responseMessages.push(decodeFrame(frame, resolved?.responseType));
      }
      notify(entry);
    }
  });
  upstream.on('trailers', (t) => {
    trailers = viewHeaders(t);
    if (grpc) {
      grpc.status = t['grpc-status'] !== undefined ? Number(t['grpc-status']) : grpc.status;
      grpc.statusMessage = grpcMessage(t['grpc-message']) ?? grpc.statusMessage;
    }
  });
  upstream.on('end', () => {
    timings.total = Number(process.hrtime.bigint() - startAt);
    responseView.body = Buffer.concat(respRaw);
    if (!clientStream.closed) clientStream.end();
    notify(entry);
  });
  upstream.on('error', (err) => {
    logger.info('grpc upstream stream error', err);
    entry.connectorError = err;
    notify(entry);
    if (!clientStream.closed) clientStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  });
}

/** grpc-message is percent-encoded on the wire. */
function grpcMessage(value: string | string[] | number | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Response headers to send downstream: keep :status, drop other pseudo + hop-by-hop. */
function downstreamHeaders(respHeaders: http2.IncomingHttpHeaders): http2.OutgoingHttpHeaders {
  const out: http2.OutgoingHttpHeaders = { ':status': respHeaders[':status'] ?? 200 };
  for (const key of Object.keys(respHeaders)) {
    if (key.startsWith(':') || HOP_BY_HOP.has(key)) continue;
    out[key] = respHeaders[key];
  }
  return out;
}
