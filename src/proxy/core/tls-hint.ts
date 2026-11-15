// A plain-HTTP client hitting an HTTPS listener (curl localhost:9900 instead
// of https://...) otherwise just sees its connection dropped. OpenSSL tells us
// exactly that happened, so we answer in plain HTTP with what to do instead.
import type { Duplex } from 'node:stream';
import type tls from 'node:tls';

export const PLAIN_HTTP_ON_TLS_HEADER = 'x-reversee-error';

export function plainHttpHint(): string {
  const body =
    'This Reversee listener expects HTTPS, but the request was sent over plain HTTP.\n' +
    'Use https:// in the URL, or switch the listen protocol to http in Reversee.\n';
  return (
    'HTTP/1.1 400 Bad Request\r\n' +
    'content-type: text/plain; charset=utf-8\r\n' +
    `content-length: ${Buffer.byteLength(body)}\r\n` +
    `${PLAIN_HTTP_ON_TLS_HEADER}: plain-http-on-https-listener\r\n` +
    'connection: close\r\n\r\n' +
    body
  );
}

/** Makes a TLS server answer plain-HTTP requests with a readable 400. */
export function answerPlainHttpOnTls(server: tls.Server): void {
  server.on('tlsClientError', (err: NodeJS.ErrnoException, tlsSocket: tls.TLSSocket) => {
    if (err.code !== 'ERR_SSL_HTTP_REQUEST') return;
    // The TLS socket never finished its handshake; the hint has to go out on
    // the raw connection underneath it (node keeps it as _parent).
    const raw = (tlsSocket as unknown as { _parent?: Duplex })._parent;
    if (raw && raw.writable) raw.end(plainHttpHint());
  });
}
