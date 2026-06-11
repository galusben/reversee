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

export interface RootCertPem {
  privateKey: string;
  publicKey: string;
  certificate: string;
}

const SETTINGS_KEY = 'appSettings';
const ROOT_CERT_KEY = 'root.cert.pem'; // legacy electron-config key path — do not rename

const store = new Store();

type Listener = (settings: AppSettings) => void;
const listeners = new Set<Listener>();

export function getSettings(): AppSettings {
  const stored = store.get(SETTINGS_KEY);
  return { ...defaultSettings, ...sanitizeSettingsPatch(stored) };
}

export function setSettings(patch: unknown): AppSettings {
  const sanitized = sanitizeSettingsPatch(patch);
  const next = { ...getSettings(), ...sanitized };
  store.set(SETTINGS_KEY, next);
  for (const listener of listeners) listener(next);
  return next;
}

export function onSettingsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * One-time import of pre-2.0 settings (renderer localStorage `userSettings`).
 * Applies only when nothing has been stored under the new key yet.
 */
export function migrateLegacySettings(old: unknown): void {
  if (store.has(SETTINGS_KEY)) return;
  if (typeof old !== 'object' || old === null) return;
  const o = old as Record<string, unknown>;
  setSettings({
    ...o,
    // Legacy ports were stored as strings.
    listenPort: Number(o['listenPort']),
    destPort: Number(o['destPort']),
  });
}

export function getRootCertPem(): RootCertPem | undefined {
  return store.get(ROOT_CERT_KEY) as RootCertPem | undefined;
}

export function setRootCertPem(pem: RootCertPem): void {
  store.set(ROOT_CERT_KEY, pem);
}

export function resetCache(): void {
  store.delete(SETTINGS_KEY);
  for (const listener of listeners) listener(getSettings());
}
