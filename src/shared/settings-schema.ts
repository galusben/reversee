// Application settings: shape, defaults, and sanitization. Shared by the main
// process settings store, the renderer form, and the MCP update_config tool.
import type { Protocol, ProxySettings } from './types';

export interface AppSettings {
  listenProtocol: Protocol;
  listenPort: number;
  destProtocol: Protocol;
  dest: string;
  destPort: number;
  interceptRequest: boolean;
  requestInterceptor: string;
  interceptResponse: boolean;
  responseInterceptor: string;
  /** Rewrite absolute 3xx Location headers back to the listen address. */
  rewriteRedirects: boolean;
  /** Rewrite the Host header to the destination. */
  rewriteHost: boolean;
  allowSelfSignedUpstream: boolean;
}

export const defaultSettings: AppSettings = {
  listenProtocol: 'http',
  listenPort: 8000,
  destProtocol: 'https',
  dest: '',
  destPort: 443,
  interceptRequest: false,
  requestInterceptor: "requestParams.headers['custom-header'] = 'custom value'",
  interceptResponse: false,
  responseInterceptor: "responseParams.headers['custom-header'] = 'custom value'",
  // The old app's menu checkboxes defaulted to checked.
  rewriteRedirects: true,
  rewriteHost: true,
  allowSelfSignedUpstream: true,
};

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isProtocol(value: unknown): value is Protocol {
  return value === 'http' || value === 'https';
}

/**
 * Returns only the keys of `patch` that are valid AppSettings fields with
 * valid values. Unknown keys and invalid values are dropped.
 */
export function sanitizeSettingsPatch(patch: unknown): Partial<AppSettings> {
  if (typeof patch !== 'object' || patch === null) return {};
  const p = patch as Record<string, unknown>;
  const out: Partial<AppSettings> = {};

  if (isProtocol(p['listenProtocol'])) out.listenProtocol = p['listenProtocol'];
  if (isProtocol(p['destProtocol'])) out.destProtocol = p['destProtocol'];
  if (isValidPort(p['listenPort'])) out.listenPort = p['listenPort'];
  if (isValidPort(p['destPort'])) out.destPort = p['destPort'];
  if (typeof p['dest'] === 'string') out.dest = p['dest'];
  for (const key of [
    'interceptRequest',
    'interceptResponse',
    'rewriteRedirects',
    'rewriteHost',
    'allowSelfSignedUpstream',
  ] as const) {
    if (typeof p[key] === 'boolean') out[key] = p[key];
  }
  for (const key of ['requestInterceptor', 'responseInterceptor'] as const) {
    if (typeof p[key] === 'string') out[key] = p[key];
  }
  return out;
}

/** Maps stored app settings to the proxy core's settings shape. */
export function toProxySettings(s: AppSettings): ProxySettings {
  return {
    dest: s.dest,
    destProtocol: s.destProtocol,
    destPort: s.destPort,
    listenPort: s.listenPort,
    listenProtocol: s.listenProtocol,
    redirect: s.rewriteRedirects,
    hostRewrite: s.rewriteHost,
    allowSelfSignedUpstream: s.allowSelfSignedUpstream,
    requestInterceptor: s.requestInterceptor,
    interceptRequest: s.interceptRequest,
    responseInterceptor: s.responseInterceptor,
    interceptResponse: s.interceptResponse,
  };
}
