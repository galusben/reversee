// The proxy core: forwards one client request to its upstream and records a
// traffic entry. Electron-free and headless-testable (the logger is injected).
//
// Responses are STREAMED to the client as they arrive, so Server-Sent Events,
// long-poll bodies and large downloads behave as they would without the proxy.
// The only cases that buffer the whole response first are the ones that have
// to see it before the client does: a response interceptor and a response
// breakpoint.
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { buildCurl } from './curl';
import { BodyCapture, CAPTURE_LIMIT, decodeBodySync } from './capture';
import { interceptRequest, interceptResponse, type InterceptResult } from './interceptor';
import { matchMock, matchRoute, NO_RULES, type CompiledRules } from './rules';
import type {
  Headers,
  Logger,
  MockRule,
  ProxySettings,
  RequestParams,
  RequestView,
  ResponseView,
  RouteRule,
  Timings,
  TrafficEntry,
} from '../../shared/types';

let trafficId = 0;

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A fast exchange is reported once, when it completes; a slow one shows up as pending after this. */
const PENDING_NOTIFY_DELAY_MS = 100;
/** Minimum gap between progress updates of a still-streaming body. */
const PROGRESS_NOTIFY_INTERVAL_MS = 500;

export interface ResponseEdit {
  statusCode?: number;
  headers?: Headers;
  body?: Uint8Array | string;
}

/** Response breakpoints: decides which responses to hold, and holds them. */
export interface ResponseGate {
  /** True when the response to this request must be held (so it has to be buffered). */
  matches(request: { url: string; method: string }): boolean;
  /** Resolves with the (possibly edited) response once the user resumes it. */
  hold(
    request: { url: string; method: string },
    response: { statusCode: number; headers: Headers; body: Buffer }
  ): Promise<ResponseEdit>;
}

export interface ProxyContext {
  settings: ProxySettings;
  /**
   * `streamId` correlates the repeated notifies of one exchange (pending ->
   * streaming -> done) so the store updates a single entry in place.
   */
  notify: (entry: TrafficEntry, streamId?: string) => void;
  rules?: CompiledRules;
  responseGate?: ResponseGate;
  logger?: Logger;
  /** Bytes of each response body kept for the traffic view. */
  captureLimit?: number;
}

export function buildRequestParams(
  requestParams: RequestParams,
  userSettings: ProxySettings,
  clientReq: http.IncomingMessage,
  route?: RouteRule | null
): void {
  requestParams.protocol =
    requestParams.protocol || route?.destProtocol || userSettings.destProtocol;
  requestParams.host = requestParams.host || route?.dest || userSettings.dest;
  requestParams.path = requestParams.path || clientReq.url;
  requestParams.method = requestParams.method || clientReq.method;
  requestParams.port = requestParams.port || route?.destPort || userSettings.destPort;
  requestParams.headers = requestParams.headers || clientReq.headers;
  // Self-signed upstreams are the common dev use case, so verification is
  // opt-in, and scoped to this request rather than process-global.
  requestParams.rejectUnauthorized = userSettings.allowSelfSignedUpstream === false;
}

/** Options for the upstream request: only the documented fields, plus mTLS when configured. */
export function upstreamRequestOptions(
  requestParams: RequestParams,
  settings: ProxySettings
): https.RequestOptions {
  const options: https.RequestOptions = {
    host: requestParams.host,
    port: requestParams.port,
    path: requestParams.path,
    method: requestParams.method,
    headers: requestParams.headers as http.OutgoingHttpHeaders,
    rejectUnauthorized: requestParams.rejectUnauthorized,
  };
  if (requestParams.protocol === 'https' && settings.upstreamClientCert) {
    options.cert = settings.upstreamClientCert.cert;
    options.key = settings.upstreamClientCert.key;
  }
  return options;
}

function bodyLength(body: unknown): number {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (body instanceof Uint8Array) return body.length;
  return 0;
}

function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body === undefined || body === null) return Buffer.alloc(0);
  return Buffer.from(String(body));
}

/** Case-insensitive header lookup that returns the key as it is actually spelled. */
function findHeaderKey(headers: Record<string, unknown>, name: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return key;
  }
  return undefined;
}

/**
 * An edited body (interceptor, breakpoint) with the original content-length
 * makes keep-alive peers hang or truncate. Only an existing header is
 * corrected; a chunked message stays chunked.
 */
function syncContentLength(headers: Record<string, unknown>, body: unknown): void {
  const key = findHeaderKey(headers, 'content-length');
  if (key !== undefined) headers[key] = String(bodyLength(body));
}

function recordIntercept(
  entry: TrafficEntry,
  phase: 'request' | 'response',
  result: InterceptResult
): void {
  if (result.error) (entry.interceptorErrors ??= []).push({ phase, message: result.error });
  if (result.logs.length) (entry.interceptorLogs ??= []).push(...result.logs);
}

export function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  ctx: ProxyContext,
  requestParams: RequestParams
): void {
  const { settings } = ctx;
  const logger = ctx.logger ?? noop;
  const rules = ctx.rules ?? NO_RULES;
  const captureLimit = ctx.captureLimit ?? CAPTURE_LIMIT;

  // startAt is a local only — a bigint must not live on the timings object,
  // which gets recorded and JSON-serialized (e.g. for the MCP tools).
  const startAt = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - startAt);
  const timings: Timings = { start: new Date() };
  const streamId = randomUUID();

  // What the client actually asked for, before routing or interception —
  // response breakpoints match on this, like request breakpoints do.
  const clientUrl = clientReq.url ?? '/';
  const clientMethod = clientReq.method ?? 'GET';

  logger.info('path hit:', clientReq.url);

  const effectiveHeaders = requestParams.headers || clientReq.headers;
  const effectivePath = requestParams.path || clientUrl;
  const route = matchRoute(rules, effectiveHeaders['host'] as string | undefined, effectivePath);
  buildRequestParams(requestParams, settings, clientReq, route);

  const responseView: ResponseView = { headers: {}, body: Buffer.alloc(0) };
  const requestView: RequestView = {
    url: requestParams.path as string,
    headers: requestParams.headers ?? {},
    method: requestParams.method as string,
    body: Buffer.alloc(0),
  };
  const entry: TrafficEntry = {
    trafficId: trafficId++,
    request: requestView,
    response: responseView,
    timings,
    pending: true,
  };

  // ---- notification plumbing ----
  let finalized = false;
  let announced = false;
  let pendingTimer: NodeJS.Timeout | null = null;
  let progressTimer: NodeJS.Timeout | null = null;
  let headerTimer: NodeJS.Timeout | null = null;
  let snapshot: (() => void) | null = null;
  let disposeCapture: (() => void) | null = null;

  const emit = (): void => {
    announced = true;
    ctx.notify(entry, streamId);
  };
  const scheduleProgress = (): void => {
    if (finalized || progressTimer || !announced) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      if (finalized) return;
      snapshot?.();
      emit();
    }, PROGRESS_NOTIFY_INTERVAL_MS);
  };
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    for (const timer of [pendingTimer, progressTimer, headerTimer]) {
      if (timer) clearTimeout(timer);
    }
    disposeCapture?.();
    timings.total ??= elapsed();
    delete entry.pending;
    emit();
  };
  const announcePending = (): void => {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (finalized) return;
      snapshot?.(); // include whatever has already streamed
      emit();
    }, PENDING_NOTIFY_DELAY_MS);
  };

  const setResponseHeader = (key: string, value: unknown): void => {
    try {
      clientRes.setHeader(key, value as string | string[]);
      (responseView.headers as Record<string, unknown>)[key] = value;
    } catch (e) {
      // e.g. an interceptor set a header to undefined or an illegal value.
      logger.warn(`dropping invalid response header "${key}"`, e);
    }
  };

  // ---- mock rules: answered here, the upstream is never contacted ----
  const mock = matchMock(rules, requestParams.method as string, requestParams.path as string);
  if (mock) {
    requestView.body = toBuffer(requestParams.body);
    requestView.size = bodyLength(requestParams.body);
    serveMock(mock);
    return;
  }

  if (settings.requestInterceptor && settings.interceptRequest) {
    requestView.beforeScript = {
      url: requestParams.path as string,
      method: requestParams.method as string,
      headers: { ...requestParams.headers },
    };
    recordIntercept(
      entry,
      'request',
      interceptRequest(requestParams, settings.requestInterceptor, logger)
    );
  }

  const headers = (requestParams.headers ??= {});
  requestView.url = requestParams.path as string;
  requestView.method = requestParams.method as string;
  requestView.headers = headers;
  const protocol = requestParams.protocol === 'https' ? 'https' : 'http';
  requestView.target = {
    protocol,
    host: requestParams.host as string,
    port: requestParams.port as number,
  };

  const originalHost = headers['host'];
  if (settings.hostRewrite) {
    headers['host'] = requestParams.host + ':' + requestParams.port;
  }
  syncContentLength(headers, requestParams.body);
  requestView.curl = buildCurl(protocol, requestParams);
  requestView.body = requestParams.body;
  requestView.size = bodyLength(requestParams.body);

  let timedOut = false;
  const failUpstream = (err: NodeJS.ErrnoException): void => {
    if (finalized) return;
    logger.info(err);
    entry.connectorError = err;
    if (clientRes.headersSent) {
      // The upstream died mid-body: the client must see a broken response,
      // not a clean end that looks like a complete (truncated) body.
      snapshot?.();
      clientRes.destroy();
      finalize();
      return;
    }
    const status = timedOut ? 504 : 502;
    const code = err.code ?? 'UPSTREAM_ERROR';
    const text =
      `Reversee could not get a response from the upstream.\n\n` +
      `Upstream: ${protocol}://${requestParams.host}:${requestParams.port}${requestParams.path}\n` +
      `Error: ${code} — ${err.message}\n`;
    const errorHeaders: Record<string, string> = {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
      'x-reversee-error': /^[\w-]+$/.test(code) ? code : 'UPSTREAM_ERROR',
    };
    clientRes.statusCode = status;
    for (const key of Object.keys(errorHeaders)) setResponseHeader(key, errorHeaders[key]);
    clientRes.end(text);
    responseView.statusCode = status;
    responseView.body = Buffer.from(text);
    responseView.size = Buffer.byteLength(text);
    finalize();
  };

  // http.request validates its input synchronously: an interceptor or a
  // breakpoint edit that produced an illegal method, header or path must fail
  // this one request, not throw out of the handler and take the worker down.
  let connector: http.ClientRequest;
  try {
    connector = (protocol === 'https' ? https : http).request(
      upstreamRequestOptions(requestParams, settings),
      onResponse
    );
  } catch (err) {
    failUpstream(err as NodeJS.ErrnoException);
    return;
  }

  const timeoutMs = (settings.upstreamTimeoutSec ?? 0) * 1000;
  if (timeoutMs > 0) {
    headerTimer = setTimeout(() => {
      timedOut = true;
      const err = new Error(
        `no response from the upstream within ${settings.upstreamTimeoutSec} s`
      ) as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      connector.destroy(err);
    }, timeoutMs);
  }

  connector.on('socket', (socket) => {
    // A keep-alive socket is handed to many requests. Listening on one that is
    // already connected would never fire and would pile up three listeners
    // per request for as long as the socket lives.
    if (!socket.connecting) return;
    socket.once('lookup', () => {
      timings.dnsLookup = elapsed();
    });
    socket.once('connect', () => {
      timings.tcpConnection = elapsed();
    });
    socket.once('secureConnect', () => {
      timings.tlsHandshake = elapsed();
    });
  });

  connector.on('error', failUpstream);
  // A write racing the client's disconnect must not surface as an uncaught error.
  clientRes.on('error', (err) => logger.debug('client response error', err));

  // The client went away before the response completed: stop the upstream
  // work instead of downloading a body nobody will read.
  clientRes.on('close', () => {
    if (finalized || clientRes.writableFinished) return;
    entry.clientAborted = true;
    snapshot?.();
    connector.destroy();
    finalize();
  });

  announcePending();
  if (requestParams.body && bodyLength(requestParams.body) > 0) {
    connector.write(requestParams.body);
  }
  connector.end();

  // ---- response handling ----

  function onResponse(serverResponse: http.IncomingMessage): void {
    if (headerTimer) {
      clearTimeout(headerTimer);
      headerTimer = null;
    }
    timings.firstByte = elapsed();

    const interceptOn = Boolean(settings.responseInterceptor && settings.interceptResponse);
    const hold = ctx.responseGate?.matches({ url: clientUrl, method: clientMethod }) ?? false;
    if (interceptOn || hold) {
      bufferThenSend(serverResponse, interceptOn, hold);
    } else {
      streamThrough(serverResponse);
    }
  }

  /** Writes status + headers to the client (not flushed) and mirrors them into the view. */
  function applyHead(
    statusCode: number | undefined,
    responseHeaders: Record<string, unknown>,
    upstreamStatus: number | undefined,
    upstreamLocation: string | undefined
  ): void {
    clientRes.statusCode = statusCode ?? 200;
    responseView.statusCode = statusCode;
    for (const key of Object.keys(responseHeaders)) setResponseHeader(key, responseHeaders[key]);

    if (settings.redirect && String(upstreamStatus).startsWith('30') && upstreamLocation) {
      logger.info('handling redirect, location:', upstreamLocation);
      try {
        const url = new URL(upstreamLocation);
        url.host = (originalHost as string) || url.host;
        url.protocol = settings.listenProtocol;
        setResponseHeader('location', url.href);
      } catch (e) {
        logger.info(e); // a relative Location is left untouched
      }
    }
  }

  function streamThrough(serverResponse: http.IncomingMessage): void {
    applyHead(
      serverResponse.statusCode,
      { ...serverResponse.headers },
      serverResponse.statusCode,
      serverResponse.headers['location']
    );
    const capture = new BodyCapture(serverResponse.headers['content-encoding'], captureLimit);
    disposeCapture = () => capture.destroy();
    snapshot = () => {
      const snap = capture.snapshot();
      responseView.body = snap.body;
      responseView.size = capture.size;
      if (snap.truncated) responseView.truncated = true;
    };
    // Send the head now: an event stream's client must not wait for the first
    // body chunk (or, worse, the end of the body) to learn it is connected.
    clientRes.flushHeaders();

    serverResponse.on('data', (chunk: Buffer) => {
      capture.write(chunk);
      if (!clientRes.write(chunk)) {
        serverResponse.pause();
        clientRes.once('drain', () => serverResponse.resume());
      }
      scheduleProgress();
    });
    serverResponse.on('end', () => {
      timings.total = elapsed();
      clientRes.end();
      void capture.finish().then((snap) => {
        responseView.body = snap.body;
        responseView.size = capture.size;
        if (snap.truncated) responseView.truncated = true;
        if (snap.decodeError) {
          logger.info('response decode failed:', snap.decodeError);
          responseView.decodeError = snap.decodeError;
        }
        snapshot = null;
        finalize();
      });
    });
    serverResponse.on('error', failUpstream);
    serverResponse.on('close', () => {
      if (finalized || serverResponse.complete) return;
      failUpstream(new Error('upstream closed the connection mid-response'));
    });
  }

  function bufferThenSend(
    serverResponse: http.IncomingMessage,
    interceptOn: boolean,
    hold: boolean
  ): void {
    const chunks: Buffer[] = [];
    serverResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
    serverResponse.on('error', failUpstream);
    serverResponse.on('close', () => {
      if (finalized || serverResponse.complete) return;
      failUpstream(new Error('upstream closed the connection mid-response'));
    });
    serverResponse.on('end', () => {
      timings.total = elapsed();
      const responseParams = {
        statusCode: serverResponse.statusCode,
        headers: { ...serverResponse.headers } as Record<string, unknown>,
        body: Buffer.concat(chunks) as Buffer | string,
      };

      if (interceptOn) {
        recordIntercept(
          entry,
          'response',
          interceptResponse(
            responseParams,
            settings.responseInterceptor as string,
            requestParams,
            logger
          )
        );
        syncContentLength(responseParams.headers, responseParams.body);
      }

      const send = (): void => {
        if (finalized) return; // the client left while the response was held
        applyHead(
          responseParams.statusCode,
          responseParams.headers,
          serverResponse.statusCode,
          serverResponse.headers['location']
        );
        const wire = toBuffer(responseParams.body);
        clientRes.end(wire);

        // Decompression is for the traffic view only; the wire body is
        // always passed through unmodified.
        const capture = new BodyCapture(responseView.headers['content-encoding'], captureLimit);
        capture.write(wire);
        void capture.finish().then((snap) => {
          responseView.body = snap.body;
          responseView.size = wire.length;
          if (snap.truncated) responseView.truncated = true;
          if (snap.decodeError) {
            logger.info('response decode failed:', snap.decodeError);
            responseView.decodeError = snap.decodeError;
          }
          finalize();
        });
      };

      if (!hold || !ctx.responseGate) {
        send();
        return;
      }
      // A held response is shown for editing, so hand over readable text:
      // decompress it and drop the encoding (the edited body goes out plain).
      const encodingKey = findHeaderKey(responseParams.headers, 'content-encoding');
      if (encodingKey) {
        const plain = decodeBodySync(
          toBuffer(responseParams.body),
          responseParams.headers[encodingKey]
        );
        if (plain) {
          responseParams.body = plain;
          delete responseParams.headers[encodingKey];
        }
      }
      void ctx.responseGate
        .hold(
          { url: clientUrl, method: clientMethod },
          {
            statusCode: responseParams.statusCode ?? 200,
            headers: responseParams.headers as Headers,
            body: toBuffer(responseParams.body),
          }
        )
        .then((edit) => {
          if (edit.statusCode !== undefined) responseParams.statusCode = edit.statusCode;
          if (edit.headers) responseParams.headers = { ...edit.headers };
          if (edit.body !== undefined) {
            responseParams.body = typeof edit.body === 'string' ? edit.body : toBuffer(edit.body);
          }
          syncContentLength(responseParams.headers, responseParams.body);
          send();
        });
    });
  }

  function serveMock(rule: MockRule): void {
    entry.mocked = true;
    const body = Buffer.from(rule.body ?? '');
    let timer: NodeJS.Timeout | null = null;
    const respond = (): void => {
      timer = null;
      if (finalized) return;
      timings.firstByte = elapsed();
      clientRes.statusCode = rule.statusCode;
      responseView.statusCode = rule.statusCode;
      for (const key of Object.keys(rule.headers)) setResponseHeader(key, rule.headers[key]);
      if (!clientRes.hasHeader('content-length')) {
        setResponseHeader('content-length', String(body.length));
      }
      clientRes.end(body);
      responseView.body = body;
      responseView.size = body.length;
      finalize();
    };
    clientRes.on('close', () => {
      if (finalized || clientRes.writableFinished) return;
      if (timer) clearTimeout(timer);
      entry.clientAborted = true;
      finalize();
    });
    if (rule.delayMs && rule.delayMs > 0) {
      announcePending();
      timer = setTimeout(respond, rule.delayMs);
    } else {
      respond();
    }
  }
}
