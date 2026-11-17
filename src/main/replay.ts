// Re-sends a captured request to its upstream, optionally with edits, and
// returns a TrafficEntry for it — the agent equivalent of "copy as curl, tweak,
// run again". Lives in main (uses node http/https + zlib).
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { buildCurl } from '../proxy/core/curl';
import { readClientCert } from './client-cert';
import type { ReplayOverrides } from '../shared/ipc';
import { verifiesUpstream, type AppSettings } from '../shared/settings-schema';
import type { Headers, RequestView, TrafficEntry, UpstreamTarget } from '../shared/types';

export type { ReplayOverrides };

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
      case 'gzip':
        return zlib.gunzipSync(body);
      case 'br':
        return zlib.brotliDecompressSync(body);
      case 'deflate':
        return zlib.inflateSync(body);
      default:
        return body;
    }
  } catch {
    return body; // keep raw bytes if decoding fails
  }
}

export interface ReplayOptions {
  /** PEM client certificate + key for https upstreams (mutual TLS). */
  clientCert?: { cert: string; key: string };
  /** Give up waiting for the response head after this long; 0 = never. */
  timeoutMs?: number;
}

export function replayRequest(
  source: ReplaySource,
  overrides: ReplayOverrides,
  rejectUnauthorized: boolean,
  options: ReplayOptions = {}
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

  // A replaced body with the captured content-length makes the upstream wait
  // for bytes that never come (or cut the body short).
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-length') headers[key] = String(body?.length ?? 0);
  }

  const requestView: RequestView = {
    url: path,
    method,
    headers,
    body: body ? Buffer.from(body) : undefined,
    size: body?.length ?? 0,
    target: source.target,
    curl: buildCurl(protocol, { host, port, path, method, headers, body }),
  };

  const startAt = process.hrtime.bigint();
  const start = new Date();
  const mod = protocol === 'https' ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      entry: Partial<TrafficEntry> & { response: TrafficEntry['response'] }
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        trafficId: 0, // assigned by TrafficStore
        replay: true,
        request: requestView,
        timings: { start, total: Number(process.hrtime.bigint() - startAt) },
        ...entry,
      });
    };

    const req = mod.request(
      {
        host,
        port,
        path,
        method,
        headers,
        rejectUnauthorized,
        ...(protocol === 'https' && options.clientCert
          ? { cert: options.clientCert.cert, key: options.clientCert.key }
          : {}),
      },
      (res) => {
        if (timer) clearTimeout(timer);
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (err) =>
          finish({ connectorError: err, response: { statusCode: res.statusCode, headers: {} } })
        );
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          finish({
            response: {
              statusCode: res.statusCode,
              headers: { ...res.headers },
              body: decodeForView(raw, Array.isArray(encoding) ? encoding[0] : encoding),
              size: raw.length,
            },
          });
        });
      }
    );
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(
            () =>
              req.destroy(
                new Error(`no response from the upstream within ${options.timeoutMs! / 1000} s`)
              ),
            options.timeoutMs
          )
        : null;
    req.on('error', (err) => {
      finish({ connectorError: err, response: { statusCode: 502, headers: {} } });
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Replays a stored entry using the app's current upstream TLS settings.
 * Rejects when the entry cannot be replayed (no recorded upstream, e.g. a
 * mocked or imported-without-URL request) or the client certificate is unusable.
 */
export async function replayEntry(
  entry: TrafficEntry,
  overrides: ReplayOverrides,
  settings: AppSettings
): Promise<TrafficEntry> {
  if (!entry.request.target) {
    throw new Error('that entry has no recorded upstream target to replay to');
  }
  return replayRequest(
    {
      target: entry.request.target,
      method: entry.request.method,
      url: entry.request.url,
      headers: entry.request.headers,
      body: entry.request.body,
    },
    overrides,
    verifiesUpstream(settings),
    {
      clientCert: readClientCert(settings),
      timeoutMs: settings.upstreamTimeoutSec * 1000,
    }
  );
}
