// Builds a copy-pasteable curl command for the upstream request.
import type { Protocol, RequestParams } from '../../shared/types';

function shellQuote(value: unknown): string {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Bodies above this are not inlined: the command is recorded with every
 * exchange (and copied to the window), so a large upload must not turn into a
 * string of the same size. Matches the traffic view's capture cap.
 */
export const CURL_INLINE_BODY_LIMIT = 2 * 1024 * 1024;

/** Where a too-large body is read from in the generated command. */
export const CURL_BODY_FILE = 'request-body.bin';

export interface CurlOptions {
  /**
   * The body passed in is only the start of the real one (a streamed upload
   * keeps a bounded copy): never inline it, point at the file instead.
   */
  bodyTruncated?: boolean;
}

export function buildCurl(
  protocol: Protocol,
  requestParams: RequestParams,
  options: CurlOptions = {}
): string {
  const defaultPort = protocol === 'https' ? 443 : 80;
  const port = requestParams.port;
  const portPart = port && String(port) !== String(defaultPort) ? ':' + port : '';
  const url = `${protocol}://${requestParams.host}${portPart}${requestParams.path}`;

  const parts = ['curl', '-X', requestParams.method ?? 'GET', shellQuote(url)];
  const headers = requestParams.headers ?? {};
  for (const key of Object.keys(headers)) {
    const raw = headers[key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      parts.push('-H', shellQuote(`${key}: ${value}`));
    }
  }
  const body = requestParams.body;
  if (body && body.length) {
    const bytes = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
    if (options.bodyTruncated || bytes > CURL_INLINE_BODY_LIMIT) {
      // A truncated inline body would be a silently wrong command; point at a
      // file the user saves the real body to instead.
      parts.push('--data-binary', shellQuote('@' + CURL_BODY_FILE));
    } else {
      parts.push('--data-binary', shellQuote(Buffer.from(body).toString()));
    }
  }
  return parts.join(' ');
}
