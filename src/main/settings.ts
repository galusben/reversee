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

// Created lazily: constructing it at import time would resolve userData
// before the REVERSEE_USER_DATA test override in main/index.ts applies.
// The file holds the root CA key, so it is created owner-only.
let storeInstance: Store | null = null;
function store(): Store {
  if (!storeInstance) storeInstance = new Store({ configFileMode: 0o600 });
  return storeInstance;
}

type Listener = (settings: AppSettings) => void;
const listeners = new Set<Listener>();

export function getSettings(): AppSettings {
  const stored = store().get(SETTINGS_KEY);
  return { ...defaultSettings, ...sanitizeSettingsPatch(stored) };
}

export function setSettings(patch: unknown): AppSettings {
  const sanitized = sanitizeSettingsPatch(patch);
  const next = { ...getSettings(), ...sanitized };
  store().set(SETTINGS_KEY, next);
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
  if (store().has(SETTINGS_KEY)) return;
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

export function resetCache(): void {
  store().delete(SETTINGS_KEY);
  for (const listener of listeners) listener(getSettings());
}
