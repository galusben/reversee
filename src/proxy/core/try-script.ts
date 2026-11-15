// Dry run of an interceptor script against a captured exchange: the same
// engine the proxy uses, but nothing is sent and nothing is recorded.
import { interceptRequest, interceptResponse, type ResponseParams } from './interceptor';
import type {
  Headers,
  RequestParams,
  ScriptTrialInput,
  ScriptTrialResult,
} from '../../shared/types';

function text(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body === undefined || body === null) return '';
  return String(body);
}

/** Whatever the script left in the headers, as something that can be shown. */
function plainHeaders(headers: unknown): Headers {
  const out: Headers = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return out;
}

export function tryScript(input: ScriptTrialInput): ScriptTrialResult {
  const requestParams: RequestParams = {
    host: input.request.host,
    port: input.request.port,
    path: input.request.path,
    method: input.request.method,
    headers: { ...input.request.headers },
    body: Buffer.from(input.request.body),
  };
  const requestView = (): ScriptTrialResult['request'] => ({
    method: String(requestParams.method ?? ''),
    path: String(requestParams.path ?? ''),
    host: String(requestParams.host ?? ''),
    port: Number(requestParams.port ?? 0),
    headers: plainHeaders(requestParams.headers),
    body: text(requestParams.body),
  });

  if (input.kind === 'request' || !input.response) {
    const { error, logs } = interceptRequest(requestParams, input.code);
    return { request: requestView(), error, logs };
  }

  const responseParams: ResponseParams = {
    statusCode: input.response.statusCode,
    headers: { ...input.response.headers },
    body: Buffer.from(input.response.body),
  };
  const { error, logs } = interceptResponse(responseParams, input.code, requestParams);
  return {
    // Response scripts get a copy of the request, so it comes back unchanged.
    request: requestView(),
    response: {
      statusCode: Number(responseParams.statusCode ?? 0),
      headers: plainHeaders(responseParams.headers),
      body: text(responseParams.body),
    },
    error,
    logs,
  };
}
