// Re-sends a captured request to its upstream, optionally with edits, and
// returns a TrafficEntry for it — the agent equivalent of "copy as curl, tweak,
// run again". Lives in main (uses node http/https + zlib).
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { buildCurl } from '../proxy/core/curl';
import type { Headers, RequestView, TrafficEntry, UpstreamTarget } from '../shared/types';

export interface ReplayOverrides {
  method?: string;
  /** Request path (e.g. /api/users?page=2). */
  url?: string;
  /** Merged into the original headers; a null value deletes that header. */
  headers?: Record<string, string | null>;
  /** Replacement request body. */
  body?: string;
}

export interface ReplaySource {
  target: UpstreamTarget;
  method: string;
  url: string;
  headers: Headers;
  body?: Uint8Array;
}

function decodeForView(body: Buffer, encoding: string | undefined): Buffer {
  try {
    switch (encoding) {
      case 'gzip': return zlib.gunzipSync(body);
      case 'br': return zlib.brotliDecompressSync(body);
      case 'deflate': return zlib.inflateSync(body);
      default: return body;
    }
  } catch {
    return body; // keep raw bytes if decoding fails
  }
}

export function replayRequest(
  source: ReplaySource,
  overrides: ReplayOverrides,
  rejectUnauthorized: boolean
): Promise<TrafficEntry> {
  const headers: Record<string, string | string[] | undefined> = { ...source.headers };
  if (overrides.headers) {
    for (const [k, v] of Object.entries(overrides.headers)) {
      if (v === null) delete headers[k];
      else headers[k] = v;
    }
  }
  const method = overrides.method ?? source.method;
  const path = overrides.url ?? source.url;
  const body = overrides.body !== undefined ? Buffer.from(overrides.body) : source.body;
  const { protocol, host, port } = source.target;

  const requestView: RequestView = {
    url: path,
    method,
    headers,
    body: body ? Buffer.from(body) : undefined,
    target: source.target,
    curl: buildCurl(protocol, { host, port, path, method, headers, body }),
  };

  const startAt = process.hrtime.bigint();
  const mod = protocol === 'https' ? https : http;

  return new Promise((resolve) => {
    const finish = (entry: Partial<TrafficEntry> & { response: TrafficEntry['response'] }): void => {
      resolve({
        trafficId: 0, // assigned by TrafficStore
        replay: true,
        request: requestView,
        timings: { start: new Date(), total: Number(process.hrtime.bigint() - startAt) },
        ...entry,
      });
    };

    const req = mod.request({ host, port, path, method, headers, rejectUnauthorized }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        finish({
          response: {
            statusCode: res.statusCode,
            headers: { ...res.headers },
            body: decodeForView(raw, Array.isArray(encoding) ? encoding[0] : encoding),
          },
        });
      });
    });
    req.on('error', (err) => {
      finish({ connectorError: err, response: { statusCode: 502, headers: {} } });
    });
    if (body) req.write(body);
    req.end();
  });
}
