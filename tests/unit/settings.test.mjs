// Settings persistence (src/main/settings.ts) against an in-memory stand-in
// for electron-store. Pins the storage layout: settings under 'appSettings'
// and the root CA under the legacy electron-config key path 'root.cert.pem',
// which existing installs depend on to keep their OS-trusted root CA.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const backing = new Map();

vi.mock('electron-store', () => ({
  default: class FakeStore {
    get(key) {
      return backing.get(key);
    }
    set(key, value) {
      backing.set(key, structuredClone(value));
    }
    has(key) {
      return backing.has(key);
    }
    delete(key) {
      backing.delete(key);
    }
  },
}));

const settings = await import('../../src/main/settings');
const { defaultSettings } = await import('../../src/shared/settings-schema');

beforeEach(() => {
  backing.clear();
});

describe('getSettings / setSettings', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(settings.getSettings()).toEqual(defaultSettings);
  });

  it('merges a patch over the current settings and persists under appSettings', () => {
    const next = settings.setSettings({ dest: 'example.com', listenPort: 9000 });
    expect(next).toEqual({ ...defaultSettings, dest: 'example.com', listenPort: 9000 });
    expect(backing.get('appSettings')).toEqual(next);
    expect(settings.setSettings({ destPort: 8443 })).toMatchObject({
      dest: 'example.com',
      listenPort: 9000,
      destPort: 8443,
    });
  });

  it('sanitizes patches before persisting', () => {
    settings.setSettings({ listenPort: 0, mcpAllowControl: 'yes', bogus: 1 });
    expect(backing.get('appSettings')).toEqual(defaultSettings);
  });

  it('ignores corrupt stored values instead of surfacing them', () => {
    backing.set('appSettings', { listenPort: 'nope', dest: 7, rewriteHost: false });
    expect(settings.getSettings()).toEqual({ ...defaultSettings, rewriteHost: false });
  });

  it('notifies listeners with the new settings, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const off = settings.onSettingsChanged(listener);
    settings.setSettings({ dest: 'a.com' });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ dest: 'a.com' }));
    off();
    settings.setSettings({ dest: 'b.com' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('migrateLegacySettings', () => {
  it('imports pre-2.0 settings, converting string ports', () => {
    settings.migrateLegacySettings({
      dest: 'legacy.com',
      listenPort: '8081',
      destPort: '443',
      destProtocol: 'https',
    });
    expect(settings.getSettings()).toMatchObject({
      dest: 'legacy.com',
      listenPort: 8081,
      destPort: 443,
      destProtocol: 'https',
    });
  });

  it('is a no-op once settings exist', () => {
    settings.setSettings({ dest: 'current.com' });
    settings.migrateLegacySettings({ dest: 'legacy.com' });
    expect(settings.getSettings().dest).toBe('current.com');
  });

  it('ignores non-object payloads', () => {
    settings.migrateLegacySettings('garbage');
    settings.migrateLegacySettings(null);
    expect(backing.has('appSettings')).toBe(false);
  });
});

describe('resetCache', () => {
  it('drops settings but keeps the root CA, and notifies listeners with defaults', () => {
    const pem = { privateKey: 'k', publicKey: 'p', certificate: 'c' };
    settings.setRootCertPem(pem);
    settings.setSettings({ dest: 'a.com' });
    const listener = vi.fn();
    const off = settings.onSettingsChanged(listener);

    settings.resetCache();

    expect(settings.getSettings()).toEqual(defaultSettings);
    expect(settings.getRootCertPem()).toEqual(pem);
    expect(listener).toHaveBeenCalledWith(defaultSettings);
    off();
  });
});

describe('root CA storage', () => {
  it('uses the legacy root.cert.pem key path', () => {
    const pem = { privateKey: 'k', publicKey: 'p', certificate: 'c' };
    expect(settings.getRootCertPem()).toBeUndefined();
    settings.setRootCertPem(pem);
    expect(backing.get('root.cert.pem')).toEqual(pem);
    expect(settings.getRootCertPem()).toEqual(pem);
  });
});
