// What the window's traffic list holds: an entry without its bodies and curl
// command. Bodies (up to 2 MB each) were pushed to the window with every
// traffic event and mirrored for the whole history; now the window keeps rows
// and fetches the one full entry it is showing (`getTrafficEntry`).
// Pure and browser-safe (no Buffer).
import type { RequestView, ResponseView, TrafficEntry } from './types';

export type RequestRow = Omit<RequestView, 'body' | 'curl'>;
export type ResponseRow = Omit<ResponseView, 'body'>;

export type TrafficRow = Omit<TrafficEntry, 'request' | 'response'> & {
  request: RequestRow;
  response: ResponseRow;
};

function byteLength(body: Uint8Array | string | undefined): number | undefined {
  if (body === undefined) return undefined;
  return typeof body === 'string' ? new TextEncoder().encode(body).length : body.length;
}

/** The entry as a list row; `size` is filled in from the body when the core did not set it. */
export function toTrafficRow(entry: TrafficEntry): TrafficRow {
  const { body: requestBody, ...request } = entry.request;
  delete (request as Partial<RequestView>).curl;
  const { body: responseBody, ...response } = entry.response;
  return {
    ...entry,
    request: { ...request, size: request.size ?? byteLength(requestBody) },
    response: { ...response, size: response.size ?? byteLength(responseBody) },
  };
}
