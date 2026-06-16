// Structured decoding of opaque values agents (and humans) trip over — JWTs,
// most commonly. Pure and browser-safe (no Buffer): shared by the GUI and the
// MCP tools. JWTs are decoded for inspection only; signatures are NOT verified.
import type { Headers, TrafficEntry } from './types';

function base64UrlToString(part: string): string {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** When the `exp` claim is present, whether it is in the past (epoch seconds). */
  expired?: boolean;
  expiresAt?: string;
  issuedAt?: string;
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Decodes a JWT string, or returns null if it is not a well-formed JWT. */
export function decodeJwt(token: string, nowSeconds = Math.floor(Date.now() / 1000)): DecodedJwt | null {
  const t = token.trim();
  if (!JWT_RE.test(t)) return null;
  const [h, p] = t.split('.');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlToString(h));
    payload = JSON.parse(base64UrlToString(p));
  } catch {
    return null;
  }
  if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null) {
    return null;
  }
  const out: DecodedJwt = { header, payload };
  const exp = payload['exp'];
  if (typeof exp === 'number') {
    out.expired = exp < nowSeconds;
    out.expiresAt = new Date(exp * 1000).toISOString();
  }
  const iat = payload['iat'];
  if (typeof iat === 'number') out.issuedAt = new Date(iat * 1000).toISOString();
  return out;
}

export interface FoundToken {
  /** Where it was found, e.g. "request Authorization" or "response set-cookie: session". */
  location: string;
  raw: string;
  jwt: DecodedJwt;
}

function scanHeaders(headers: Headers, side: string, out: FoundToken[]): void {
  for (const key of Object.keys(headers)) {
    const raw = headers[key];
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const lower = key.toLowerCase();
    for (const value of values) {
      if (lower === 'authorization') {
        const m = value.match(/^Bearer\s+(.+)$/i);
        const jwt = m && decodeJwt(m[1]);
        if (jwt) out.push({ location: `${side} Authorization`, raw: m![1], jwt });
      } else if (lower === 'cookie' || lower === 'set-cookie') {
        // name=value; name2=value2 — decode any value that is a JWT.
        for (const pair of value.split(/;\s*/)) {
          const eq = pair.indexOf('=');
          if (eq < 0) continue;
          const name = pair.slice(0, eq).trim();
          const v = pair.slice(eq + 1).trim();
          const jwt = decodeJwt(v);
          if (jwt) out.push({ location: `${side} ${lower}: ${name}`, raw: v, jwt });
        }
      }
    }
  }
}

/** Finds and decodes JWTs in a request/response (Authorization + cookies). */
export function findTokens(entry: TrafficEntry): FoundToken[] {
  const out: FoundToken[] = [];
  scanHeaders(entry.request.headers, 'request', out);
  scanHeaders(entry.response.headers, 'response', out);
  return out;
}
