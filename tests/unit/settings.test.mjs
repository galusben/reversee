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
  settings.setSecretCodec(null);
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

// The root CA key is encrypted at rest when a system keychain is available.
describe('root CA key storage', () => {
  const pem = { privateKey: 'PRIVATE', publicKey: 'PUBLIC', certificate: 'CERT' };
  const codec = {
    encrypt: (plain) => `enc(${plain})`,
    decrypt: (enc) => {
      const m = /^enc\((.*)\)$/.exec(enc);
      if (!m) throw new Error('cannot decrypt');
      return m[1];
    },
  };

  it('keeps the legacy plaintext layout when no codec is installed', () => {
    settings.setRootCertPem(pem);
    expect(backing.get('root.cert.pem')).toEqual(pem);
    expect(settings.readRootCert()).toEqual({ state: 'ok', pem });
  });

  it('stores the key encrypted, never in plaintext, once a codec is installed', () => {
    settings.setSecretCodec(codec);
    settings.setRootCertPem(pem);
    const stored = backing.get('root.cert.pem');
    expect(stored).toEqual({
      certificate: 'CERT',
      publicKey: 'PUBLIC',
      privateKeyEnc: 'enc(PRIVATE)',
    });
    expect(JSON.stringify(stored)).not.toContain('"privateKey"');
    expect(settings.getRootCertPem()).toEqual(pem);
  });

  it('migrates an existing plaintext key on first read, keeping the same certificate', () => {
    backing.set('root.cert.pem', pem);
    settings.setSecretCodec(codec);
    expect(settings.readRootCert()).toEqual({ state: 'ok', pem });
    expect(backing.get('root.cert.pem')).toEqual({
      certificate: 'CERT',
      publicKey: 'PUBLIC',
      privateKeyEnc: 'enc(PRIVATE)',
    });
    // And it still reads back after the migration.
    expect(settings.getRootCertPem()).toEqual(pem);
  });

  it('keeps the plaintext key if encrypting it fails', () => {
    backing.set('root.cert.pem', pem);
    settings.setSecretCodec({
      ...codec,
      encrypt: () => {
        throw new Error('keychain denied');
      },
    });
    expect(settings.readRootCert()).toEqual({ state: 'ok', pem });
    expect(backing.get('root.cert.pem')).toEqual(pem);
  });

  it('reports an encrypted key as locked, without discarding it, when it cannot be decrypted', () => {
    backing.set('root.cert.pem', {
      certificate: 'CERT',
      publicKey: 'PUBLIC',
      privateKeyEnc: 'garbage',
    });
    settings.setSecretCodec(codec);
    expect(settings.readRootCert()).toEqual({
      state: 'locked',
      certificate: 'CERT',
      reason: 'cannot decrypt',
    });
    expect(settings.getRootCertPem()).toBeUndefined();
    expect(backing.get('root.cert.pem').privateKeyEnc).toBe('garbage');
  });

  it('reports an encrypted key as locked when no keychain is available at all', () => {
    backing.set('root.cert.pem', {
      certificate: 'CERT',
      publicKey: 'PUBLIC',
      privateKeyEnc: 'enc(X)',
    });
    expect(settings.readRootCert()).toMatchObject({ state: 'locked', certificate: 'CERT' });
  });

  it('reports missing when nothing usable is stored', () => {
    expect(settings.readRootCert()).toEqual({ state: 'missing' });
    backing.set('root.cert.pem', { certificate: 'CERT' });
    expect(settings.readRootCert()).toEqual({ state: 'missing' });
  });
});
