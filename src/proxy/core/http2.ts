// HTTP/2 reverse proxy with gRPC awareness. Used instead of the plain HTTP/1.1
// server (core/server.ts) when `enableGrpc` is set, so native gRPC — which
// requires HTTP/2 framing and trailers — can be proxied and decoded.
//
// For each inbound stream it opens an upstream HTTP/2 stream and pipes bytes
// both ways UNMODIFIED (the wire is never altered), while copying frames
// through a FrameAccumulator to decode gRPC messages and capturing the
// grpc-status trailer. Works for unary and all streaming modes: messages
// accumulate as DATA frames arrive and the traffic entry is re-emitted (the
// store upserts by streamId). Upstream sessions are shared per origin.
//
// HTTP/1.1 is served on the same port, through the regular HTTP/1.1 handlers
// (interceptors, breakpoints, mocks, WebSockets all work):
// - https: ALPN picks h2 or http/1.1 per connection.
// - http: the first bytes are sniffed — the HTTP/2 client preface selects h2
//   (cleartext prior knowledge), anything else is HTTP/1.1.
// HTTP/2 streams themselves are passed through as-is: interceptors and
// breakpoints do not apply to them.
//
// Electron-free (node:http2 only).
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { CAPTURE_LIMIT } from './capture';
import { FrameAccumulator, decodeFrame } from './grpc-frames';
import { compileRules, matchRoute, type CompiledRules } from './rules';
import { createHttp1Handlers, type ProxyServer, type ProxyServerOptions } from './server';
import type { ResolvedMethod } from './grpc-registry';
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

/** The HTTP/1.1 options (gate, responseGate, …) apply to the HTTP/1.1 connections it serves. */
export interface Http2ProxyServerOptions extends ProxyServerOptions {
  /** Resolves a gRPC `:path` to the message types that decode its frames. */
  resolveMethod?: (path: string) => ResolvedMethod | undefined;
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
  const rules = compileRules(settings, logger);
  const http1 = createHttp1Handlers(options);
  const upstreams = new UpstreamSessions(settings, logger);
  const connections = new Set<net.Socket>();

  const onStream = (
    clientStream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders
  ): void => {
    forwardStream(clientStream, headers, {
      settings,
      notify,
      logger,
      rules,
      upstreams,
      resolveMethod: options.resolveMethod,
    });
  };
  const onError = (err: NodeJS.ErrnoException): void => {
    logger.error('http2 proxy server error', err);
    options.onServerError?.(err);
  };

  let listener: net.Server;
  if (settings.listenProtocol === 'https') {
    const secure = http2.createSecureServer({
      key: options.sslOptions?.key,
      cert: options.sslOptions?.cert,
      allowHTTP1: true,
    });
    // Node wires its HTTP/2 compatibility layer the moment a 'request'
    // listener is added, which would then ALSO handle every h2 stream (and
    // send trailers a second time). Dropping that hook keeps 'request' for
    // what we want it for: the HTTP/1.1 connections ALPN hands us.
    secure.removeAllListeners('newListener');
    secure.on('request', (req, res) =>
      http1.onRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse)
    );
    secure.on('upgrade', http1.onUpgrade);
    secure.on('stream', onStream);
    listener = secure;
  } else {
    const h2 = http2.createServer();
    h2.on('stream', onStream);
    h2.on('error', onError);
    const h1 = http.createServer(http1.onRequest);
    h1.on('upgrade', http1.onUpgrade);
    h1.on('error', onError);
    // Neither inner server listens; the front socket server feeds them.
    listener = net.createServer((socket) => {
      socket.on('error', (err) => logger.debug('client socket error', err));
      sniffProtocol(socket, (isHttp2) => (isHttp2 ? h2 : h1).emit('connection', socket));
    });
  }

  listener.on('connection', (socket: net.Socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  listener.on('error', onError);

  return {
    get listening(): boolean {
      return listener.listening;
    },
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(settings.listenPort, () => {
          listener.removeListener('error', reject);
          const address = listener.address();
          const port = typeof address === 'object' && address ? address.port : settings.listenPort;
          logger.info(`http2 proxy listening on ${settings.listenProtocol}://localhost:${port}`);
          resolve(port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        // Open streams and idle upstream sessions would otherwise keep
        // close() pending forever, and Stop would never complete.
        http1.closeTunnels();
        upstreams.closeAll();
        listener.close(() => resolve());
        for (const socket of connections) socket.destroy();
        connections.clear();
      });
    },
  };
}

const H2_PREFACE = Buffer.from('PRI * HTTP/2.0');

/**
 * Decides whether a cleartext connection speaks HTTP/2 (prior knowledge) by
 * peeking at its first bytes, then puts them back so the chosen server sees
 * the stream from the start.
 */
function sniffProtocol(socket: net.Socket, done: (isHttp2: boolean) => void): void {
  const tryRead = (): void => {
    const chunk = socket.read() as Buffer | null;
    if (chunk === null) {
      socket.once('readable', tryRead);
      return;
    }
    // A preface split across packets is vanishingly rare; treat a short
    // first read that matches so far as HTTP/2 only when it is a full match.
    const isHttp2 =
      chunk.length >= H2_PREFACE.length && chunk.subarray(0, H2_PREFACE.length).equals(H2_PREFACE);
    socket.unshift(chunk);
    done(isHttp2);
  };
  tryRead();
}

/** One shared upstream HTTP/2 session per origin, recreated when it dies. */
class UpstreamSessions {
  private sessions = new Map<string, http2.ClientHttp2Session>();

  constructor(
    private settings: ProxySettings,
    private logger: Logger
  ) {}

  get(origin: string): http2.ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const clientCert = origin.startsWith('https:') ? this.settings.upstreamClientCert : undefined;
    const session = http2.connect(origin, {
      rejectUnauthorized: this.settings.allowSelfSignedUpstream === false,
      ...(clientCert ? { cert: clientCert.cert, key: clientCert.key } : {}),
    });
    // Every in-flight call listens for the session failing.
    session.setMaxListeners(0);
    const forget = (): void => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on('error', (err) => {
      this.logger.info('grpc upstream session error', err);
      forget();
    });
    session.on('close', forget);
    // The upstream is going away: finish what is in flight, start new calls elsewhere.
    session.on('goaway', forget);
    this.sessions.set(origin, session);
    return session;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
  }
}

interface ForwardContext {
  settings: ProxySettings;
  notify: (entry: TrafficEntry, streamId?: string) => void;
  logger: Logger;
  rules: CompiledRules;
  upstreams: UpstreamSessions;
  resolveMethod?: (path: string) => ResolvedMethod | undefined;
}

function forwardStream(
  clientStream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  ctx: ForwardContext
): void {
  const { settings, logger, resolveMethod } = ctx;
  // One id per call so main updates the same entry as streaming frames arrive,
  // instead of appending a new row per notify.
  const streamId = randomUUID();
  const notify = (entry: TrafficEntry): void => ctx.notify(entry, streamId);
  const startAt = process.hrtime.bigint();
  const timings: Timings = { start: new Date() };

  const path = String(headers[':path'] ?? '');
  const method = String(headers[':method'] ?? 'POST');
  const contentType = String(headers['content-type'] ?? '');
  const isGrpc = contentType.startsWith('application/grpc');
  const resolved = isGrpc ? resolveMethod?.(path) : undefined;

  const route = matchRoute(ctx.rules, String(headers[':authority'] ?? ''), path);
  const target = {
    protocol: route?.destProtocol ?? settings.destProtocol,
    host: route?.dest ?? settings.dest,
    port: route?.destPort ?? settings.destPort,
  };
  const upstreamOrigin = `${target.protocol === 'https' ? 'https' : 'http'}://${target.host}:${target.port}`;

  const requestView: RequestView = {
    url: path,
    method,
    headers: viewHeaders(headers),
    body: Buffer.alloc(0),
    target,
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
    pending: true,
  };
  notify(entry); // surface the row immediately; re-emitted as frames/trailers arrive

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    timings.total ??= Number(process.hrtime.bigint() - startAt);
    delete entry.pending;
    notify(entry);
  };

  const session = ctx.upstreams.get(upstreamOrigin);
  const onSessionError = (err: Error): void => {
    if (finalized) return;
    entry.connectorError = err;
    responseView.statusCode = 502;
    if (!clientStream.closed) clientStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    finalize();
  };
  session.on('error', onSessionError);

  // Build the upstream request headers: keep gRPC/content headers, drop the
  // inbound pseudo-headers and hop-by-hop, and let http2 set :authority/:scheme.
  const outHeaders: http2.OutgoingHttpHeaders = { ':method': method, ':path': path };
  for (const key of Object.keys(headers)) {
    if (key.startsWith(':') || HOP_BY_HOP.has(key)) continue;
    outHeaders[key] = headers[key];
  }
  let upstream: http2.ClientHttp2Stream;
  try {
    upstream = session.request(outHeaders);
  } catch (err) {
    // e.g. a connection-specific header HTTP/2 forbids, or a session that
    // died this instant: fail this stream, not the worker.
    session.removeListener('error', onSessionError);
    onSessionError(err as Error);
    return;
  }
  upstream.on('close', () => {
    session.removeListener('error', onSessionError);
    finalize();
  });

  // --- request direction: client -> upstream (raw passthrough + decode copy) ---
  const reqAcc = new FrameAccumulator();
  const reqRaw: Buffer[] = [];
  let reqBytes = 0;
  clientStream.on('data', (chunk: Buffer) => {
    upstream.write(chunk);
    reqBytes += chunk.length;
    if (reqBytes <= CAPTURE_LIMIT) reqRaw.push(chunk);
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
    requestView.size = reqBytes;
    if (reqBytes > CAPTURE_LIMIT) requestView.truncated = true;
  });
  clientStream.on('error', (err) => {
    logger.info('grpc client stream error', err);
    if (!upstream.closed) upstream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  });
  // The client cancelled (deadline, RST_STREAM): stop the upstream call too.
  clientStream.on('close', () => {
    if (!upstream.closed) upstream.close(http2.constants.NGHTTP2_CANCEL);
  });

  // --- response direction: upstream -> client ---
  const respAcc = new FrameAccumulator();
  const respRaw: Buffer[] = [];
  let respBytes = 0;
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
    respBytes += chunk.length;
    if (respBytes <= CAPTURE_LIMIT) respRaw.push(chunk);
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
    responseView.size = respBytes;
    if (respBytes > CAPTURE_LIMIT) responseView.truncated = true;
    if (!clientStream.closed) clientStream.end();
    finalize();
  });
  upstream.on('error', (err) => {
    logger.info('grpc upstream stream error', err);
    entry.connectorError ??= err;
    if (!clientStream.closed) clientStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    finalize();
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
