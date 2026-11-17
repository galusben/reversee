// Settings persistence. Uses electron-store with the default store name
// ('config' -> userData/config.json) and keeps the legacy electron-config key
// path 'root.cert.pem' so existing users' OS-trusted root CA survives the
// upgrade untouched.
import Store from 'electron-store';
import {
  defaultSettings,
  sanitizeSettingsPatch,
  type AppSettings,
} from '../shared/settings-schema';
import {
  MAX_TABS,
  defaultTabSettings,
  newStoredTab,
  nextFreeListenPort,
  pickTabSettings,
  renameAutoTabs,
  sanitizeTabsState,
  splitSettingsPatch,
  tabNameError,
  type GlobalSettings,
  type StoredTab,
  type StoredTabsState,
  type TabSettings,
} from '../shared/tabs';

export interface RootCertPem {
  privateKey: string;
  publicKey: string;
  certificate: string;
}

// 'appSettings' holds the global settings. It also mirrors the active tab's
// settings, so the flat layout every earlier version reads stays meaningful
// (a downgrade sees the tab that was active). 'tabs' holds the tabs.
const SETTINGS_KEY = 'appSettings';
const TABS_KEY = 'tabs';
const ROOT_CERT_KEY = 'root.cert.pem'; // legacy electron-config key path — do not rename

// Created lazily: constructing it at import time would resolve userData
// before the REVERSEE_USER_DATA test override in main/index.ts applies.
// The file holds the root CA key, so it is created owner-only.
let storeInstance: Store | null = null;
function store(): Store {
  if (!storeInstance) storeInstance = new Store({ configFileMode: 0o600 });
  return storeInstance;
}

/** Called with a tab's full (global + per-tab) settings after they change. */
type Listener = (settings: AppSettings, tabId: string) => void;
const listeners = new Set<Listener>();
type TabsListener = (state: StoredTabsState) => void;
const tabsListeners = new Set<TabsListener>();

function storedFlat(): Partial<AppSettings> {
  return sanitizeSettingsPatch(store().get(SETTINGS_KEY));
}

function globalSettings(): GlobalSettings {
  const { global } = splitSettingsPatch({ ...defaultSettings, ...storedFlat() });
  return global as GlobalSettings;
}

/**
 * The saved tabs. The first read after upgrading from a single-proxy version
 * turns the flat settings into tab t1, so nothing changes for that user.
 */
export function getTabsState(): StoredTabsState {
  const saved = sanitizeTabsState(store().get(TABS_KEY));
  if (saved) return saved;
  const first = newStoredTab(1, pickTabSettings(storedFlat()), []);
  return { activeTabId: first.id, nextTabNumber: 2, tabs: [first] };
}

function writeTabsState(state: StoredTabsState): void {
  store().set(TABS_KEY, state);
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  store().set(SETTINGS_KEY, { ...globalSettings(), ...active?.settings });
}

function findTab(state: StoredTabsState, tabId: string | undefined): StoredTab {
  const id = tabId ?? state.activeTabId;
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) throw new Error(`no tab with id ${id}`);
  return tab;
}

function notifyTabs(state: StoredTabsState): void {
  for (const listener of tabsListeners) listener(state);
}

function notifySettings(tabId: string): void {
  const settings = getSettings(tabId);
  for (const listener of listeners) listener(settings, tabId);
}

export function getActiveTabId(): string {
  return getTabsState().activeTabId;
}

/** A tab's full settings: the global ones plus its own. Defaults to the active tab. */
export function getSettings(tabId?: string): AppSettings {
  const tab = findTab(getTabsState(), tabId);
  return { ...defaultSettings, ...globalSettings(), ...tab.settings };
}

/**
 * Applies a patch: global keys to every tab, the rest to one tab (the active
 * tab by default). Invalid keys and values are dropped. Returns that tab's
 * full settings.
 */
export function setSettings(patch: unknown, tabId?: string): AppSettings {
  const { global, tab: tabPatch } = splitSettingsPatch(sanitizeSettingsPatch(patch));
  const state = getTabsState();
  const target = findTab(state, tabId);
  const renamed = renameAutoTabs(
    state.tabs.map((t) => (t === target ? { ...t, settings: { ...t.settings, ...tabPatch } } : t))
  );
  const nextState = { ...state, tabs: renamed };
  if (Object.keys(global).length) {
    store().set(SETTINGS_KEY, { ...storedFlat(), ...global });
  }
  writeTabsState(nextState);
  const namesChanged = renamed.some((t, i) => t.name !== state.tabs[i]?.name);
  notifySettings(target.id);
  // A global change (theme, MCP, history cap) concerns the window's tab too.
  if (Object.keys(global).length && target.id !== state.activeTabId) {
    notifySettings(state.activeTabId);
  }
  if (namesChanged) notifyTabs(nextState);
  return getSettings(target.id);
}

export function onSettingsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onTabsChanged(listener: TabsListener): () => void {
  tabsListeners.add(listener);
  return () => tabsListeners.delete(listener);
}

export function setActiveTabId(tabId: string): void {
  const state = getTabsState();
  findTab(state, tabId);
  if (state.activeTabId === tabId) return;
  const next = { ...state, activeTabId: tabId };
  writeTabsState(next);
  notifyTabs(next);
  notifySettings(tabId);
}

export interface CreateTabOptions {
  /** Copy this tab's settings (on the next free listen port). */
  duplicateOf?: string;
  /** Settings for the new tab (over the defaults or the duplicated tab's). */
  settings?: Partial<TabSettings>;
  /** A name for the tab; it must be unique. */
  name?: string;
  /** Make it the window's tab (default true). */
  activate?: boolean;
}

export type CreateTabResult = { ok: true; tab: StoredTab } | { ok: false; error: string };

export function createTab(options: CreateTabOptions = {}): CreateTabResult {
  const state = getTabsState();
  if (state.tabs.length >= MAX_TABS) {
    return { ok: false, error: `At most ${MAX_TABS} tabs can be open` };
  }
  const base = options.duplicateOf
    ? state.tabs.find((t) => t.id === options.duplicateOf)?.settings
    : undefined;
  if (options.duplicateOf && !base) {
    return { ok: false, error: `no tab with id ${options.duplicateOf}` };
  }
  const patch = pickTabSettings(sanitizeSettingsPatch(options.settings ?? {}));
  const settings: TabSettings = {
    ...defaultTabSettings,
    ...base,
    ...patch,
  };
  // Two tabs cannot listen on one port; pick a free one unless one was asked for.
  if (patch.listenPort === undefined) {
    settings.listenPort = nextFreeListenPort(state.tabs, base ? base.listenPort : 8000);
  }
  let tab = newStoredTab(state.nextTabNumber, settings, state.tabs);
  if (options.name !== undefined) {
    const error = tabNameError(
      options.name,
      state.tabs.map((t) => t.name)
    );
    if (error) return { ok: false, error };
    tab = { ...tab, name: options.name.trim(), nameIsCustom: true };
  }
  const next: StoredTabsState = {
    activeTabId: options.activate === false ? state.activeTabId : tab.id,
    nextTabNumber: state.nextTabNumber + 1,
    tabs: [...state.tabs, tab],
  };
  writeTabsState(next);
  notifyTabs(next);
  if (next.activeTabId !== state.activeTabId) notifySettings(next.activeTabId);
  return { ok: true, tab };
}

/**
 * Removes a tab's saved settings. Closing the last tab leaves a fresh, empty
 * one so there is always a tab. Returns false when no such tab exists.
 */
export function closeTab(tabId: string): boolean {
  const state = getTabsState();
  const index = state.tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return false;
  let tabs = state.tabs.filter((t) => t.id !== tabId);
  let nextTabNumber = state.nextTabNumber;
  if (tabs.length === 0) {
    tabs = [newStoredTab(nextTabNumber, {}, [])];
    nextTabNumber++;
  }
  // Freed auto-name suffixes are reused ("api #2" may become "api").
  tabs = renameAutoTabs(tabs);
  const activeTabId =
    state.activeTabId === tabId
      ? (tabs[Math.min(index, tabs.length - 1)] as StoredTab).id
      : state.activeTabId;
  const next = { activeTabId, nextTabNumber, tabs };
  writeTabsState(next);
  notifyTabs(next);
  if (activeTabId !== state.activeTabId) notifySettings(activeTabId);
  return true;
}

export type RenameTabResult = { ok: true; tab: StoredTab } | { ok: false; error: string };

/** Names a tab. An empty name gives the tab back its automatic name. */
export function renameTab(tabId: string, name: string): RenameTabResult {
  const state = getTabsState();
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return { ok: false, error: `no tab with id ${tabId}` };
  let tabs: StoredTab[];
  if (!name.trim()) {
    tabs = state.tabs.map((t) => (t.id === tabId ? { ...t, nameIsCustom: false } : t));
  } else {
    const error = tabNameError(
      name,
      state.tabs.filter((t) => t.id !== tabId).map((t) => t.name)
    );
    if (error) return { ok: false, error };
    tabs = state.tabs.map((t) =>
      t.id === tabId ? { ...t, name: name.trim(), nameIsCustom: true } : t
    );
  }
  tabs = renameAutoTabs(tabs);
  const next = { ...state, tabs };
  writeTabsState(next);
  notifyTabs(next);
  return { ok: true, tab: tabs.find((t) => t.id === tabId) as StoredTab };
}

/** Moves a tab to a new position in the strip. */
export function moveTab(tabId: string, toIndex: number): void {
  const state = getTabsState();
  const from = state.tabs.findIndex((t) => t.id === tabId);
  if (from < 0) return;
  const tabs = state.tabs.slice();
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab as StoredTab);
  const next = { ...state, tabs };
  writeTabsState(next);
  notifyTabs(next);
}

/**
 * One-time import of pre-2.0 settings (renderer localStorage `userSettings`).
 * Applies only when nothing has been stored under the new keys yet.
 */
export function migrateLegacySettings(old: unknown): void {
  if (store().has(SETTINGS_KEY) || store().has(TABS_KEY)) return;
  if (typeof old !== 'object' || old === null) return;
  const o = old as Record<string, unknown>;
  setSettings({
    ...o,
    // Legacy ports were stored as strings.
    listenPort: Number(o['listenPort']),
    destPort: Number(o['destPort']),
  });
}

/**
 * Encrypts the root CA private key at rest (Electron safeStorage: Keychain on
 * macOS, DPAPI on Windows, the desktop keyring on Linux). The app asks users
 * to trust this CA system-wide, so a plaintext key in config.json would let
 * anything that can read that file (another process, a backup, a synced
 * folder) mint certificates the machine trusts.
 */
export interface SecretCodec {
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

let secretCodec: SecretCodec | null = null;

/** Installed by main once the app is ready; null keeps the legacy plaintext layout. */
export function setSecretCodec(codec: SecretCodec | null): void {
  secretCodec = codec;
}

interface StoredRootCert {
  certificate?: string;
  publicKey?: string;
  /** Legacy / no-keychain layout. */
  privateKey?: string;
  /** Encrypted with the SecretCodec. */
  privateKeyEnc?: string;
}

export type RootCertRead =
  | { state: 'missing' }
  | { state: 'ok'; pem: RootCertPem }
  /** A root exists but its key cannot be decrypted right now; it must not be overwritten. */
  | { state: 'locked'; certificate: string; reason: string };

/**
 * Reads the stored root CA. A plaintext key is migrated to the encrypted
 * layout the first time a codec is available.
 */
export function readRootCert(): RootCertRead {
  const stored = store().get(ROOT_CERT_KEY) as StoredRootCert | undefined;
  if (!stored || typeof stored.certificate !== 'string') return { state: 'missing' };
  const publicKey = stored.publicKey ?? '';

  if (typeof stored.privateKeyEnc === 'string') {
    if (!secretCodec) {
      return {
        state: 'locked',
        certificate: stored.certificate,
        reason: 'the system keychain is not available',
      };
    }
    try {
      const privateKey = secretCodec.decrypt(stored.privateKeyEnc);
      return { state: 'ok', pem: { privateKey, publicKey, certificate: stored.certificate } };
    } catch (e) {
      return { state: 'locked', certificate: stored.certificate, reason: (e as Error).message };
    }
  }

  if (typeof stored.privateKey !== 'string') return { state: 'missing' };
  const pem: RootCertPem = {
    privateKey: stored.privateKey,
    publicKey,
    certificate: stored.certificate,
  };
  if (secretCodec) {
    try {
      setRootCertPem(pem); // one-time migration of the plaintext key
    } catch {
      // Encryption failed: keep the working plaintext copy rather than lose the key.
    }
  }
  return { state: 'ok', pem };
}

/** The stored root CA when it is readable (see readRootCert for the other states). */
export function getRootCertPem(): RootCertPem | undefined {
  const read = readRootCert();
  return read.state === 'ok' ? read.pem : undefined;
}

export function setRootCertPem(pem: RootCertPem): void {
  if (!secretCodec) {
    store().set(ROOT_CERT_KEY, pem);
    return;
  }
  const stored: StoredRootCert = {
    certificate: pem.certificate,
    publicKey: pem.publicKey,
    privateKeyEnc: secretCodec.encrypt(pem.privateKey),
  };
  store().set(ROOT_CERT_KEY, stored);
}

/**
 * Drops every saved setting and tab, leaving one fresh tab. The root CA is
 * kept. Tab numbering continues, so an id never names two different tabs.
 */
export function resetCache(): void {
  const { nextTabNumber } = getTabsState();
  store().delete(SETTINGS_KEY);
  const tab = newStoredTab(nextTabNumber, {}, []);
  const next = { activeTabId: tab.id, nextTabNumber: nextTabNumber + 1, tabs: [tab] };
  store().set(TABS_KEY, next);
  notifyTabs(next);
  notifySettings(tab.id);
}
