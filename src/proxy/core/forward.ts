// "Capture anything" mode: the listener acts as a regular HTTP proxy, so a
// client configured with HTTP_PROXY / HTTPS_PROXY has all of its traffic
// captured, whichever servers it talks to.
//
//  - Plain HTTP arrives as absolute-form requests (GET http://host/path).
//  - HTTPS arrives as CONNECT host:443. The tunnel is answered here: we finish
//    the client's TLS handshake with a certificate issued for that host by the
//    Reversee root CA, and feed the decrypted stream to an internal HTTP
//    server, so the requests inside go through the normal proxy pipeline.
//  - Anything else inside a CONNECT tunnel is piped through untouched.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import type { Logger, TrafficEntry, UpstreamTarget } from '../../shared/types';

/** Issues a certificate (PEM) the client will accept for `host`. */
export type IssueCert = (host: string) => Promise<{ key: string; cert: string }>;

/** The slice of the HTTP/1.1 handlers the forward proxy drives. */
export interface ForwardHandlers {
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
}

export interface ForwardProxyOptions {
  handlers: ForwardHandlers;
  /** Without it HTTPS tunnels are passed through undecrypted. */
  issueCert?: IssueCert;
  notify: (entry: TrafficEntry, streamId?: string) => void;
  logger: Logger;
  /** The bound listen port, to refuse requests that would loop back into the proxy. */
  listenPort: () => number | undefined;
}

export interface ForwardProxy {
  onRequest(request: http.IncomingMessage, response: http.ServerResponse): void;
  onUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  onConnect(request: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

export const FORWARD_ERROR_HEADER = 'x-reversee-error';

/** A client that speaks first does so right away; a silent one gets a plain tunnel. */
const FIRST_BYTE_WAIT_MS = 1500;
/** One "certificate not accepted" row per host in this window (clients retry in bursts). */
const REJECTION_REPORT_INTERVAL_MS = 5000;
const MAX_CACHED_CONTEXTS = 2000;
const TLS_HANDSHAKE_RECORD = 0x16;

let trafficId = 0;

function textResponse(status: number, reason: string, code: string, body: string): string {
  return (
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'content-type: text/plain; charset=utf-8\r\n' +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    `${FORWARD_ERROR_HEADER}: ${code}\r\n` +
    'connection: close\r\n\r\n' +
    body
  );
}

/** Answer for a CONNECT (proxy) request when capture-anything mode is off. */
export function connectDisabledResponse(): string {
  return textResponse(
    405,
    'Method Not Allowed',
    'capture-anything-off',
    'This Reversee listener forwards to one server and does not accept proxy (CONNECT) requests.\n' +
      'Switch Reversee to "Capture anything" to use it as an HTTP/HTTPS proxy.\n'
  );
}

function usageText(port: number | undefined): string {
  const address = `http://localhost:${port ?? '<port>'}`;
  return (
    'Reversee is in "Capture anything" mode: it works as an HTTP proxy, not as a web server.\n\n' +
    'Point a client at it as its proxy, for example:\n' +
    `  curl -x ${address} http://example.com/\n` +
    `  HTTP_PROXY=${address} HTTPS_PROXY=${address} your-command\n\n` +
    'For HTTPS, the client must trust the Reversee root certificate\n' +
    '(export it from the Reversee menu).\n'
  );
}

/** Splits "host:port", "[v6]:port" or a bare host. Null when it is not a usable authority. */
export function parseAuthority(
  authority: string,
  defaultPort: number
): { host: string; port: number } | null {
  const match = /^(?:\[([0-9a-f:.]+)\]|([^:\s/[\]]+))(?::(\d{1,5}))?$/i.exec(authority.trim());
  if (!match) return null;
  const host = match[1] ?? match[2];
  const port = match[3] === undefined ? defaultPort : Number(match[3]);
  if (!host || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * Turns an absolute-form request ("GET http://host/path") into origin form and
 * returns the server it names. Null when the request is not absolute-form.
 */
export function takeAbsoluteTarget(request: http.IncomingMessage): UpstreamTarget | null {
  const match = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(request.url ?? '');
  if (!match) return null;
  const protocol = match[1].toLowerCase() === 'https' ? 'https' : 'http';
  const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
  const parsed = parseAuthority(authority, protocol === 'https' ? 443 : 80);
  if (!parsed) return null;
  const rest = match[3];
  request.url = rest.startsWith('/') ? rest : '/' + rest.replace(/^#.*/, '');
  return { protocol, ...parsed };
}

/** Headers addressed to the proxy itself; the server must not see them. */
function stripProxyHeaders(request: http.IncomingMessage): void {
  delete request.headers['proxy-connection'];
  delete request.headers['proxy-authorization'];
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);

export function createForwardProxy(options: ForwardProxyOptions): ForwardProxy {
  const { handlers, issueCert, logger } = options;
  /** The server each decrypted (or plain) tunnel stream leads to. */
  const targets = new WeakMap<Duplex, UpstreamTarget>();
  /** Raw tunnel sockets, destroyed on close (they are not the listener's connections any more). */
  const sockets = new Set<Duplex>();
  const contexts = new Map<string, Promise<tls.SecureContext>>();
  const lastRejection = new Map<string, number>();

  const isSelf = (target: UpstreamTarget): boolean =>
    target.port === options.listenPort() && LOCAL_NAMES.has(target.host.toLowerCase());

  // Requests that arrive inside a CONNECT tunnel. Never listens: tunnel
  // streams are handed to it as connections.
  const inner = http.createServer();
  inner.on('request', (request, response) => {
    const target = takeAbsoluteTarget(request) ?? targets.get(request.socket);
    if (!target) {
      response.writeHead(400, { connection: 'close' }).end();
      return;
    }
    stripProxyHeaders(request);
    handlers.onRequest(request, response, target);
  });
  inner.on('upgrade', (request, socket, head) => {
    const target = targets.get(request.socket);
    if (!target) {
      socket.destroy();
      return;
    }
    stripProxyHeaders(request);
    handlers.onUpgrade(request, socket, head, target);
  });
  inner.on('connect', (_request, socket) => {
    socket.end(connectDisabledResponse());
  });

  function track(socket: Duplex): void {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  }

  function contextFor(host: string): Promise<tls.SecureContext> {
    const key = host.toLowerCase();
    let context = contexts.get(key);
    if (!context) {
      if (contexts.size >= MAX_CACHED_CONTEXTS) contexts.clear();
      context = (issueCert as IssueCert)(key).then(({ key: pem, cert }) =>
        tls.createSecureContext({ key: pem, cert })
      );
      contexts.set(key, context);
      context.catch(() => contexts.delete(key));
    }
    return context;
  }

  /** The client refused our certificate (not trusted, or pinned): say so in the table. */
  function recordRejection(
    request: http.IncomingMessage,
    target: UpstreamTarget,
    detail: string
  ): void {
    const now = Date.now();
    const key = `${target.host}:${target.port}`;
    if (now - (lastRejection.get(key) ?? 0) < REJECTION_REPORT_INTERVAL_MS) return;
    if (lastRejection.size > MAX_CACHED_CONTEXTS) lastRejection.clear();
    lastRejection.set(key, now);
    const error = Object.assign(
      new Error(
        `The client did not complete the TLS handshake for ${target.host}. ` +
          'It most likely does not trust the Reversee root certificate, or it pins the ' +
          `server's own certificate. (${detail})`
      ),
      { code: 'CLIENT_TLS_REJECTED' }
    );
    options.notify({
      trafficId: trafficId++,
      request: {
        url: key,
        method: 'CONNECT',
        headers: { ...request.headers },
        body: Buffer.alloc(0),
        size: 0,
        target,
      },
      response: { headers: {}, body: Buffer.alloc(0) },
      timings: { start: new Date(), total: 0 },
      connectorError: error,
    });
  }

  /** Resolves with the first byte the client sends (left unread), or why there is none. */
  function peek(socket: Duplex): Promise<number | 'silent' | 'closed'> {
    return new Promise((resolve) => {
      const done = (result: number | 'silent' | 'closed'): void => {
        clearTimeout(timer);
        socket.removeListener('readable', onReadable);
        socket.removeListener('close', onClose);
        resolve(result);
      };
      const onReadable = (): void => {
        const chunk = socket.read() as Buffer | null;
        if (!chunk || chunk.length === 0) return;
        socket.unshift(chunk);
        done(chunk[0]);
      };
      const onClose = (): void => done('closed');
      const timer = setTimeout(() => done('silent'), FIRST_BYTE_WAIT_MS);
      socket.on('readable', onReadable);
      socket.on('close', onClose);
      onReadable();
    });
  }

  function blindTunnel(socket: Duplex, target: UpstreamTarget): void {
    const upstream = net.connect(target.port, target.host);
    track(upstream);
    upstream.on('error', (err) => {
      logger.debug('tunnel upstream error', err);
      socket.destroy();
    });
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    socket.pipe(upstream);
    upstream.pipe(socket);
  }

  async function intercept(
    request: http.IncomingMessage,
    socket: Duplex,
    target: UpstreamTarget
  ): Promise<void> {
    let context: tls.SecureContext;
    try {
      context = await contextFor(target.host);
    } catch (err) {
      logger.warn(`could not issue a certificate for ${target.host}`, err);
      socket.destroy();
      return;
    }
    if (socket.destroyed) return;

    const tlsSocket = new tls.TLSSocket(socket as net.Socket, {
      isServer: true,
      secureContext: context,
      // HTTP/1.1 only: the decrypted stream is parsed by the HTTP/1.1 server.
      ALPNProtocols: ['http/1.1'],
      // A client may connect by address and still name the host in SNI.
      SNICallback: (servername, callback) => {
        if (!servername || servername.toLowerCase() === target.host.toLowerCase()) {
          callback(null, context);
          return;
        }
        contextFor(servername).then(
          (named) => callback(null, named),
          (err: Error) => callback(err)
        );
      },
    });
    let secure = false;
    tlsSocket.once('secure', () => {
      secure = true;
    });
    let failure = 'the client closed the connection during the handshake';
    tlsSocket.on('error', (err: NodeJS.ErrnoException) => {
      failure = err.message;
      logger.debug('tunnel TLS error', err);
      tlsSocket.destroy();
    });
    // Most clients just hang up on a certificate they do not accept.
    tlsSocket.on('close', () => {
      if (!secure) recordRejection(request, target, failure);
    });
    targets.set(tlsSocket, target);
    inner.emit('connection', tlsSocket);
  }

  return {
    onRequest(request, response) {
      const target = takeAbsoluteTarget(request);
      if (!target || isSelf(target)) {
        const body = usageText(options.listenPort());
        response.writeHead(400, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          [FORWARD_ERROR_HEADER]: target ? 'proxy-loop' : 'not-a-proxy-request',
        });
        response.end(body);
        return;
      }
      stripProxyHeaders(request);
      handlers.onRequest(request, response, target);
    },

    onUpgrade(request, socket, head) {
      const target = takeAbsoluteTarget(request);
      if (!target || isSelf(target)) {
        socket.end(
          textResponse(
            400,
            'Bad Request',
            target ? 'proxy-loop' : 'not-a-proxy-request',
            usageText(options.listenPort())
          )
        );
        return;
      }
      stripProxyHeaders(request);
      handlers.onUpgrade(request, socket, head, target);
    },

    onConnect(request, socket, head) {
      const parsed = parseAuthority(request.url ?? '', 443);
      socket.on('error', (err) => logger.debug('tunnel client socket error', err));
      if (!parsed || isSelf({ protocol: 'https', ...parsed })) {
        socket.end(
          textResponse(400, 'Bad Request', 'bad-connect-target', 'Invalid CONNECT target.\n')
        );
        return;
      }
      track(socket);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);

      void peek(socket).then((first) => {
        if (first === 'closed' || socket.destroyed) return;
        if (first === TLS_HANDSHAKE_RECORD && issueCert) {
          void intercept(request, socket, { protocol: 'https', ...parsed });
        } else if (typeof first === 'number' && first >= 0x41 && first <= 0x5a) {
          // An upper-case letter: an HTTP request line (GET, POST, …) in the clear.
          targets.set(socket, { protocol: 'http', ...parsed });
          inner.emit('connection', socket);
        } else {
          blindTunnel(socket, { protocol: 'http', ...parsed });
        }
      });
    },

    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      inner.closeAllConnections();
    },
  };
}
