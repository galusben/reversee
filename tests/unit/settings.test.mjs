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
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ dest: 'a.com' }), 't1');
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
  it('drops settings and tabs but keeps the root CA, and notifies listeners with defaults', () => {
    const pem = { privateKey: 'k', publicKey: 'p', certificate: 'c' };
    settings.setRootCertPem(pem);
    settings.setSettings({ dest: 'a.com' });
    const listener = vi.fn();
    const off = settings.onSettingsChanged(listener);

    settings.createTab({ settings: { dest: 'b.com' } });
    settings.resetCache();

    expect(settings.getSettings()).toEqual(defaultSettings);
    expect(settings.getRootCertPem()).toEqual(pem);
    // One fresh tab; numbering continues so an id never names two different tabs.
    expect(settings.getTabsState().tabs.map((t) => t.id)).toEqual(['t3']);
    expect(listener).toHaveBeenCalledWith(defaultSettings, 't3');
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

describe('tabs', () => {
  it('turns the single-proxy settings of an earlier version into tab t1', () => {
    backing.set('appSettings', { dest: 'old.example', listenPort: 9100, theme: 'dark' });
    const state = settings.getTabsState();
    expect(state).toMatchObject({ activeTabId: 't1', nextTabNumber: 2 });
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ id: 't1', name: 'old.example', nameIsCustom: false });
    expect(settings.getSettings()).toMatchObject({
      dest: 'old.example',
      listenPort: 9100,
      theme: 'dark',
    });
  });

  it("keeps each tab's proxy settings apart while global ones are shared", () => {
    settings.setSettings({ dest: 'one.test', listenPort: 8000 });
    const created = settings.createTab({ settings: { dest: 'two.test' } });
    expect(created).toMatchObject({ ok: true, tab: { id: 't2', name: 'two.test' } });
    // The next listen port no other tab uses, and the new tab is shown.
    expect(settings.getSettings('t2').listenPort).toBe(8001);
    expect(settings.getActiveTabId()).toBe('t2');

    settings.setSettings({ mocks: [], rewriteHost: false }, 't2');
    settings.setSettings({ theme: 'dark' }, 't2');
    expect(settings.getSettings('t1')).toMatchObject({
      dest: 'one.test',
      rewriteHost: true,
      theme: 'dark',
    });
    expect(settings.getSettings('t2')).toMatchObject({ dest: 'two.test', rewriteHost: false });
    expect(() => settings.getSettings('t9')).toThrow(/no tab with id t9/);
  });

  it('mirrors the active tab into appSettings so an older version still reads a sensible config', () => {
    settings.setSettings({ dest: 'one.test' });
    settings.createTab({ settings: { dest: 'two.test' } });
    expect(backing.get('appSettings')).toMatchObject({ dest: 'two.test', listenPort: 8001 });
    settings.setActiveTabId('t1');
    expect(backing.get('appSettings')).toMatchObject({ dest: 'one.test', listenPort: 8000 });
  });

  it('tells the active tab about a global change made through another tab', () => {
    settings.createTab({ activate: false });
    const listener = vi.fn();
    const off = settings.onSettingsChanged(listener);
    settings.setSettings({ theme: 'light' }, 't2');
    expect(listener.mock.calls.map((c) => c[1])).toEqual(['t2', 't1']);
    off();
  });

  it('names tabs after their destination, uniquely, until the user names them', () => {
    settings.setSettings({ dest: 'api.test' });
    settings.createTab({ settings: { dest: 'api.test' } });
    settings.createTab({ settings: { dest: 'API.test' } });
    expect(settings.getTabsState().tabs.map((t) => t.name)).toEqual([
      'api.test',
      'api.test #2',
      'API.test #3',
    ]);
    // Following the destination; a freed suffix is reused.
    settings.setSettings({ dest: 'other.test' }, 't1');
    expect(settings.getTabsState().tabs.map((t) => t.name)).toEqual([
      'other.test',
      'api.test',
      'API.test #2',
    ]);
    expect(settings.renameTab('t2', 'Mobile app')).toMatchObject({ ok: true });
    settings.setSettings({ dest: 'changed.test' }, 't2');
    expect(settings.getTabsState().tabs[1].name).toBe('Mobile app');
  });

  it('refuses a tab name another tab has, or one shaped like a tab id', () => {
    settings.createTab({ name: 'Mobile' });
    expect(settings.renameTab('t1', 'mobile')).toEqual({
      ok: false,
      error: 'Another tab is already called "mobile"',
    });
    expect(settings.renameTab('t1', 't7')).toMatchObject({
      ok: false,
      error: /looks like a tab id/,
    });
    expect(settings.createTab({ name: 'MOBILE' })).toMatchObject({ ok: false });
    expect(settings.renameTab('t1', '  Web  ')).toMatchObject({ ok: true, tab: { name: 'Web' } });
    // Renaming a tab to its own name is fine; an empty name restores the automatic one.
    expect(settings.renameTab('t1', 'web')).toMatchObject({ ok: true });
    expect(settings.renameTab('t1', '')).toMatchObject({
      ok: true,
      tab: { name: 'New tab', nameIsCustom: false },
    });
  });

  it('closes tabs: the neighbour becomes active, ids are never reused, one tab always remains', () => {
    settings.createTab();
    settings.createTab();
    settings.setActiveTabId('t2');
    expect(settings.closeTab('t2')).toBe(true);
    expect(settings.getActiveTabId()).toBe('t3');
    expect(settings.closeTab('t2')).toBe(false);
    settings.closeTab('t1');
    settings.closeTab('t3');
    const state = settings.getTabsState();
    expect(state.tabs.map((t) => t.id)).toEqual(['t4']);
    expect(state.activeTabId).toBe('t4');
    expect(settings.createTab()).toMatchObject({ tab: { id: 't5' } });
  });

  it('reorders tabs', () => {
    settings.createTab();
    settings.createTab();
    settings.moveTab('t3', 0);
    expect(settings.getTabsState().tabs.map((t) => t.id)).toEqual(['t3', 't1', 't2']);
  });

  it('repairs a damaged tabs record instead of failing', () => {
    backing.set('tabs', {
      activeTabId: 't9',
      nextTabNumber: 1,
      tabs: [
        {
          id: 't2',
          name: 'Same',
          nameIsCustom: true,
          settings: { dest: 'a.test', listenPort: -5 },
        },
        { id: 't2', name: 'Dup id', nameIsCustom: true, settings: {} },
        { id: 't3', name: 'same', nameIsCustom: true, settings: { dest: 'b.test' } },
        { id: 'x', settings: {} },
        'junk',
      ],
    });
    const state = settings.getTabsState();
    expect(state.tabs.map((t) => [t.id, t.name, t.nameIsCustom])).toEqual([
      ['t2', 'Same', true],
      ['t3', 'b.test', false],
    ]);
    expect(state.activeTabId).toBe('t2');
    expect(state.nextTabNumber).toBe(4);
    expect(settings.getSettings('t2').listenPort).toBe(defaultSettings.listenPort);
  });
});
