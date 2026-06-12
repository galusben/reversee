// Builds a copy-pasteable curl command for the upstream request.
import type { Protocol, RequestParams } from '../../shared/types';

function shellQuote(value: unknown): string {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function buildCurl(protocol: Protocol, requestParams: RequestParams): string {
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
  if (requestParams.body && requestParams.body.length) {
    parts.push('--data-binary', shellQuote(Buffer.from(requestParams.body).toString()));
  }
  return parts.join(' ');
}
