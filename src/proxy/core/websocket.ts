// WebSocket support for the HTTP/1.1 listener: forwards the client's Upgrade
// request to the upstream and, once the upstream switches protocols, pipes the
// two sockets together byte for byte. A copy of each direction is parsed into
// messages for the traffic view.
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { buildCurl } from './curl';
import { BodyCapture } from './capture';
import { interceptRequest } from './interceptor';
import { buildRequestParams, upstreamRequestOptions, type ProxyContext } from './proxy';
import { matchRoute, NO_RULES } from './rules';
import { WsMessageAssembler, type AssembledMessage } from './ws-frames';
import type {
  Logger,
  RequestParams,
  RequestView,
  ResponseView,
  Timings,
  TrafficEntry,
  UpstreamTarget,
  WebSocketView,
} from '../../shared/types';

/** Most recent messages kept per connection. */
export const WS_MESSAGE_LIMIT = 300;
const NOTIFY_INTERVAL_MS = 400;

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let trafficId = 0;

function rawHead(statusLine: string, rawHeaders: string[], skip: Set<string> = new Set()): string {
  let head = statusLine + '\r\n';
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (skip.has(rawHeaders[i].toLowerCase())) continue;
    head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  }
  return head;
}

export function handleUpgrade(
  clientReq: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  ctx: ProxyContext,
  /** Live tunnel sockets, so the server can tear them down on stop. */
  sockets: Set<Duplex>,
  /** Capture-anything mode: the server the client asked for. */
  forward?: UpstreamTarget
): void {
  const { settings } = ctx;
  const logger = ctx.logger ?? noop;
  const rules = ctx.rules ?? NO_RULES;
  const startAt = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - startAt);
  const timings: Timings = { start: new Date() };
  const streamId = randomUUID();

  const requestParams: RequestParams = {};
  const route = matchRoute(rules, clientReq.headers['host'], clientReq.url ?? '/');
  buildRequestParams(requestParams, settings, clientReq, route, forward);

  const responseView: ResponseView = { headers: {}, body: Buffer.alloc(0) };
  const ws: WebSocketView = { messages: [], messageCount: 0 };
  const requestView: RequestView = {
    url: requestParams.path as string,
    method: requestParams.method as string,
    headers: requestParams.headers ?? {},
    body: Buffer.alloc(0),
    size: 0,
  };
  const entry: TrafficEntry = {
    trafficId: trafficId++,
    request: requestView,
    response: responseView,
    timings,
    pending: true,
    ws,
  };

  if (settings.requestInterceptor && settings.interceptRequest) {
    requestView.beforeScript = {
      url: requestParams.path as string,
      method: requestParams.method as string,
      headers: { ...requestParams.headers },
    };
    const result = interceptRequest(requestParams, settings.requestInterceptor, logger);
    if (result.error) entry.interceptorErrors = [{ phase: 'request', message: result.error }];
    if (result.logs.length) entry.interceptorLogs = result.logs;
  }

  const headers = (requestParams.headers ??= {});
  const protocol = requestParams.protocol === 'https' ? 'https' : 'http';
  if (settings.hostRewrite && (!forward || route))
    headers['host'] = requestParams.host + ':' + requestParams.port;
  requestView.url = requestParams.path as string;
  requestView.method = requestParams.method as string;
  requestView.headers = headers;
  requestView.target = {
    protocol,
    host: requestParams.host as string,
    port: requestParams.port as number,
  };
  requestView.curl = buildCurl(protocol, requestParams);

  let finalized = false;
  let notifyTimer: NodeJS.Timeout | null = null;
  let headerTimer: NodeJS.Timeout | null = null;
  let upstreamSocket: Duplex | null = null;
  const assemblers: WsMessageAssembler[] = [];

  const emit = (): void => ctx.notify(entry, streamId);
  const scheduleNotify = (): void => {
    if (finalized || notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      if (!finalized) emit();
    }, NOTIFY_INTERVAL_MS);
  };
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    if (notifyTimer) clearTimeout(notifyTimer);
    if (headerTimer) clearTimeout(headerTimer);
    for (const a of assemblers) a.destroy();
    sockets.delete(clientSocket);
    if (upstreamSocket) sockets.delete(upstreamSocket);
    timings.total = elapsed();
    delete entry.pending;
    emit();
  };

  const record = (from: 'client' | 'server', message: AssembledMessage): void => {
    if (finalized) return;
    ws.messageCount++;
    // The same object is kept: a compressed message gets its text filled in later.
    ws.messages.push(Object.assign(message, { from, atMs: Math.round(elapsed() / 1_000_000) }));
    if (ws.messages.length > WS_MESSAGE_LIMIT) {
      ws.messages.splice(0, ws.messages.length - WS_MESSAGE_LIMIT);
    }
    scheduleNotify();
  };

  sockets.add(clientSocket);
  clientSocket.on('error', (err) => logger.debug('websocket client socket error', err));

  let connector: http.ClientRequest;
  try {
    connector = (protocol === 'https' ? https : http).request(
      upstreamRequestOptions(requestParams, settings)
    );
  } catch (err) {
    // Illegal header/path after an interceptor edit: fail this handshake only.
    entry.connectorError = err;
    responseView.statusCode = 502;
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    finalize();
    return;
  }

  let timedOut = false;
  const timeoutMs = (settings.upstreamTimeoutSec ?? 0) * 1000;
  if (timeoutMs > 0) {
    headerTimer = setTimeout(() => {
      timedOut = true;
      connector.destroy(
        new Error(`no response from the upstream within ${settings.upstreamTimeoutSec} s`)
      );
    }, timeoutMs);
  }
  const clearHeaderTimer = (): void => {
    if (headerTimer) clearTimeout(headerTimer);
    headerTimer = null;
  };

  // The client gave up before the upstream answered.
  const onEarlyClose = (): void => {
    if (finalized) return;
    entry.clientAborted = true;
    connector.destroy();
    finalize();
  };
  clientSocket.on('close', onEarlyClose);

  connector.on('error', (err: NodeJS.ErrnoException) => {
    if (finalized) return;
    logger.info('websocket upstream error', err);
    entry.connectorError = err;
    const status = timedOut ? 504 : 502;
    const text = `Reversee could not reach the WebSocket upstream: ${err.code ?? ''} ${err.message}\n`;
    responseView.statusCode = status;
    responseView.body = Buffer.from(text);
    responseView.size = Buffer.byteLength(text);
    if (clientSocket.writable) {
      clientSocket.end(
        `HTTP/1.1 ${status} ${status === 504 ? 'Gateway Timeout' : 'Bad Gateway'}\r\n` +
          'content-type: text/plain; charset=utf-8\r\n' +
          `content-length: ${Buffer.byteLength(text)}\r\n` +
          'connection: close\r\n\r\n' +
          text
      );
    }
    finalize();
  });

  // The upstream declined to upgrade (auth failure, not a WebSocket endpoint…):
  // relay its answer as a plain close-delimited HTTP response.
  connector.on('response', (res) => {
    clearHeaderTimer();
    // From here on a close means the relay was cut short, not an early abort.
    clientSocket.removeListener('close', onEarlyClose);
    timings.firstByte = elapsed();
    responseView.statusCode = res.statusCode;
    responseView.headers = { ...res.headers };
    delete entry.ws; // it never became a WebSocket
    const capture = new BodyCapture(res.headers['content-encoding'], ctx.captureLimit);
    let relayed = false;
    // The relay ended early: keep what was captured and close the books.
    const abandon = (): void => {
      if (finalized) return;
      const snap = capture.snapshot();
      responseView.body = snap.body;
      responseView.size = capture.size;
      if (snap.truncated) responseView.truncated = true;
      capture.destroy();
      finalize();
    };
    clientSocket.write(
      rawHead(
        `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}`,
        res.rawHeaders,
        new Set(['transfer-encoding', 'content-length', 'connection', 'keep-alive'])
      ) + 'connection: close\r\n\r\n'
    );
    res.on('data', (chunk: Buffer) => {
      capture.write(chunk);
      // Backpressure: a slow client must not make the worker queue the body.
      if (!clientSocket.write(chunk)) {
        res.pause();
        clientSocket.once('drain', () => res.resume());
      }
    });
    res.on('end', () => {
      relayed = true;
      clientSocket.end();
      void capture.finish().then((snap) => {
        responseView.body = snap.body;
        responseView.size = capture.size;
        if (snap.truncated) responseView.truncated = true;
        finalize();
      });
    });
    res.on('error', (err) => logger.debug('websocket upstream response error', err));
    // The upstream died mid-body: the client must see a broken response.
    res.on('close', () => {
      if (finalized || relayed || res.complete) return;
      entry.connectorError = new Error('upstream closed the connection mid-response');
      abandon();
      clientSocket.destroy();
    });
    // The client went away mid-body: stop downloading a body nobody will read.
    clientSocket.on('close', () => {
      if (finalized || relayed) return;
      entry.clientAborted = true;
      abandon();
      res.destroy();
    });
  });

  connector.on('upgrade', (res, upSocket, upHead) => {
    clearHeaderTimer();
    timings.firstByte = elapsed();
    upstreamSocket = upSocket;
    sockets.add(upSocket);
    responseView.statusCode = res.statusCode;
    responseView.headers = { ...res.headers };

    const deflate = String(res.headers['sec-websocket-extensions'] ?? '').includes(
      'permessage-deflate'
    );
    const options = { deflate, onChange: scheduleNotify };
    const fromClient = new WsMessageAssembler((m) => record('client', m), options);
    const fromServer = new WsMessageAssembler((m) => record('server', m), options);
    assemblers.push(fromClient, fromServer);

    clientSocket.removeListener('close', onEarlyClose);
    let closing = false;
    const closeBoth = (): void => {
      if (finalized || closing) return;
      closing = true;
      ws.closed = true;
      clientSocket.destroy();
      upSocket.destroy();
      // Let in-flight inflation finish so the last messages have their text.
      void Promise.all([fromClient.idle(), fromServer.idle()]).then(finalize);
    };
    upSocket.on('error', (err) => logger.debug('websocket upstream socket error', err));
    upSocket.on('close', closeBoth);
    clientSocket.on('close', closeBoth);

    clientSocket.write(
      rawHead(`HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}`, res.rawHeaders) + '\r\n'
    );
    if (upHead.length) {
      clientSocket.write(upHead);
      fromServer.push(upHead);
    }
    if (head.length) {
      upSocket.write(head);
      fromClient.push(head);
    }

    // The copy listeners run alongside the pipes; the piped bytes are untouched.
    clientSocket.on('data', (chunk: Buffer) => fromClient.push(chunk));
    upSocket.on('data', (chunk: Buffer) => fromServer.push(chunk));
    clientSocket.pipe(upSocket);
    upSocket.pipe(clientSocket);

    emit(); // show the open connection immediately
  });

  connector.end();
}
