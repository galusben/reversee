// Settings shape, sanitization, and the mapping to the proxy core's settings.
// Every settings write (renderer form, menu, MCP update_config) goes through
// sanitizeSettingsPatch, so it is the single gate against bad persisted state.
import { describe, it, expect } from 'vitest';
import {
  defaultSettings,
  isValidPort,
  sanitizeSettingsPatch,
  toProxySettings,
} from '../../src/shared/settings-schema';

describe('isValidPort', () => {
  it('accepts integers in 1..65535', () => {
    for (const p of [1, 80, 8000, 65535]) expect(isValidPort(p)).toBe(true);
  });

  it('rejects out-of-range, fractional, and non-number values', () => {
    for (const p of [0, -1, 65536, 80.5, NaN, Infinity, '8000', null, undefined]) {
      expect(isValidPort(p)).toBe(false);
    }
  });
});

describe('defaultSettings', () => {
  it('keeps the security-relevant defaults', () => {
    // MCP is read-only unless the user opts into control.
    expect(defaultSettings.mcpEnabled).toBe(true);
    expect(defaultSettings.mcpAllowControl).toBe(false);
    expect(defaultSettings.enableGrpc).toBe(false);
    expect(defaultSettings.interceptRequest).toBe(false);
    expect(defaultSettings.interceptResponse).toBe(false);
  });

  it('is a fixed point of sanitizeSettingsPatch', () => {
    expect(sanitizeSettingsPatch(defaultSettings)).toEqual(defaultSettings);
  });
});

describe('sanitizeSettingsPatch', () => {
  it('returns an empty patch for non-objects', () => {
    for (const v of [null, undefined, 'x', 42, true]) expect(sanitizeSettingsPatch(v)).toEqual({});
  });

  it('drops unknown keys', () => {
    expect(sanitizeSettingsPatch({ dest: 'a.com', evil: 'x', __proto__: { y: 1 } })).toEqual({
      dest: 'a.com',
    });
  });

  it('drops invalid protocols and ports but keeps valid siblings', () => {
    expect(
      sanitizeSettingsPatch({
        listenProtocol: 'ftp',
        destProtocol: 'https',
        listenPort: 70000,
        destPort: 443,
      })
    ).toEqual({ destProtocol: 'https', destPort: 443 });
  });

  it('does not coerce string ports (legacy migration converts them first)', () => {
    expect(sanitizeSettingsPatch({ listenPort: '8080' })).toEqual({});
  });

  it('only accepts booleans for the flag fields', () => {
    const flags = [
      'interceptRequest',
      'interceptResponse',
      'rewriteRedirects',
      'rewriteHost',
      'allowSelfSignedUpstream',
      'mcpEnabled',
      'mcpAllowControl',
      'enableGrpc',
    ];
    for (const key of flags) {
      expect(sanitizeSettingsPatch({ [key]: 'true' })).toEqual({});
      expect(sanitizeSettingsPatch({ [key]: 1 })).toEqual({});
      expect(sanitizeSettingsPatch({ [key]: false })).toEqual({ [key]: false });
    }
  });

  it('only accepts strings for the interceptor code', () => {
    expect(sanitizeSettingsPatch({ requestInterceptor: 42, responseInterceptor: 'x' })).toEqual({
      responseInterceptor: 'x',
    });
  });
});

describe('toProxySettings', () => {
  it('maps every app setting to its proxy-core name', () => {
    const s = {
      ...defaultSettings,
      dest: 'api.example.com',
      rewriteRedirects: false,
      rewriteHost: false,
      allowSelfSignedUpstream: false,
      enableGrpc: true,
      interceptRequest: true,
      requestInterceptor: 'req',
      interceptResponse: true,
      responseInterceptor: 'res',
    };
    expect(toProxySettings(s)).toEqual({
      dest: 'api.example.com',
      destProtocol: s.destProtocol,
      destPort: s.destPort,
      listenPort: s.listenPort,
      listenProtocol: s.listenProtocol,
      redirect: false,
      hostRewrite: false,
      allowSelfSignedUpstream: false,
      requestInterceptor: 'req',
      interceptRequest: true,
      responseInterceptor: 'res',
      interceptResponse: true,
      enableGrpc: true,
    });
  });

  it('never leaks the MCP flags into the proxy worker', () => {
    const proxy = toProxySettings(defaultSettings);
    expect(proxy).not.toHaveProperty('mcpEnabled');
    expect(proxy).not.toHaveProperty('mcpAllowControl');
  });
});
