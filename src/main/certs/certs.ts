// Root CA + per-boot localhost certificate generation (node-forge). The root
// CA persists in the settings store (its key encrypted at rest when a system
// keychain is available); the localhost leaf is regenerated and signed on
// every boot.
import forge from 'node-forge';
import fs from 'node:fs/promises';
import net from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { dialog, type BrowserWindow } from 'electron';
import log from 'electron-log';
import { readRootCert, setRootCertPem, type RootCertPem } from '../settings';
import type { RootCertStatus } from '../../shared/ipc';

const SUBJECT_ATTRS = [
  { name: 'commonName', value: 'reversee.ninja' },
  { name: 'countryName', value: 'US' },
  { shortName: 'ST', value: 'Virginia' },
  { name: 'localityName', value: 'Blacksburg' },
  { name: 'organizationName', value: 'Reversee' },
  { shortName: 'OU', value: 'Reversee Web Debugger' },
];

/** New roots are long-lived: every expiry forces the user to re-trust the CA. */
export const ROOT_VALIDITY_YEARS = 10;
const LEAF_VALIDITY_DAYS = 365;
/** Warn this long before the root expires. */
export const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A positive 128-bit serial; a constant serial breaks clients that cache by issuer + serial. */
function randomSerial(): string {
  const hex = forge.util.bytesToHex(forge.random.getBytesSync(16));
  // Clear the top bit so the DER integer is positive.
  return (parseInt(hex[0], 16) & 0x7).toString(16) + hex.slice(1);
}

export function createRootCert(): RootCertPem {
  log.info('generating root CA key pair...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  // Backdated a day so a client with a slightly slow clock still accepts it.
  cert.validity.notBefore = new Date(Date.now() - DAY_MS);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + ROOT_VALIDITY_YEARS);
  cert.setSubject(SUBJECT_ATTRS);
  cert.setIssuer(SUBJECT_ATTRS);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  log.info('root CA certificate created');

  return {
    privateKey: forge.pki.privateKeyToPem(keys.privateKey),
    publicKey: forge.pki.publicKeyToPem(keys.publicKey),
    certificate: forge.pki.certificateToPem(cert),
  };
}

export interface LeafCert {
  certificate: string;
  privateKey: string;
}

/** Signs a fresh end-entity certificate for the local listener. */
export function generateAndSignCert(root: RootCertPem): LeafCert {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.certificateFromPem(root.certificate);
  const caKey = forge.pki.privateKeyFromPem(root.privateKey);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - DAY_MS);
  // A leaf must not outlive its issuer.
  cert.validity.notAfter = new Date(
    Math.min(Date.now() + LEAF_VALIDITY_DAYS * DAY_MS, caCert.validity.notAfter.getTime())
  );
  cert.setSubject([
    { name: 'commonName', value: 'localhost' },
    { name: 'organizationName', value: 'Reversee' },
    { shortName: 'OU', value: 'Reversee Web Debugger' },
  ]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    // An end-entity certificate: it must not be able to sign other certificates.
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        // Clients that connect by address verify against an IP SAN.
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' },
      ],
    },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  log.info('localhost certificate signed');

  return {
    certificate: forge.pki.certificateToPem(cert),
    privateKey: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * Issues certificates for arbitrary hosts, signed by the root ("Capture
 * anything" mode presents one per HTTPS host). All of them share one key pair,
 * generated on first use: signing is fast, key generation is not.
 */
export function createHostCertIssuer(root: RootCertPem): (host: string) => LeafCert {
  const caCert = forge.pki.certificateFromPem(root.certificate);
  const caKey = forge.pki.privateKeyFromPem(root.privateKey);
  let keys: { publicKey: forge.pki.PublicKey; privateKeyPem: string } | null = null;

  return (host) => {
    if (!keys) {
      const pair = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      keys = {
        publicKey: forge.pki.publicKeyFromPem(pair.publicKey),
        privateKeyPem: pair.privateKey,
      };
    }
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date(Date.now() - DAY_MS);
    cert.validity.notAfter = new Date(
      Math.min(Date.now() + LEAF_VALIDITY_DAYS * DAY_MS, caCert.validity.notAfter.getTime())
    );
    cert.setSubject([
      // A common name holds at most 64 characters; clients match on the SAN anyway.
      { name: 'commonName', value: host.slice(0, 64) },
      { name: 'organizationName', value: 'Reversee' },
      { shortName: 'OU', value: 'Reversee Web Debugger' },
    ]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [net.isIP(host) ? { type: 7, ip: host } : { type: 2, value: host }],
      },
    ]);
    cert.sign(caKey, forge.md.sha256.create());
    return { certificate: forge.pki.certificateToPem(cert), privateKey: keys.privateKeyPem };
  };
}

export type { RootCertStatus };

export function rootCertStatus(root: RootCertPem, now: number = Date.now()): RootCertStatus {
  const notAfter = forge.pki.certificateFromPem(root.certificate).validity.notAfter;
  const daysLeft = Math.floor((notAfter.getTime() - now) / DAY_MS);
  return {
    notAfter: notAfter.toISOString(),
    daysLeft,
    expired: notAfter.getTime() <= now,
    expiringSoon: daysLeft < EXPIRY_WARNING_DAYS,
  };
}

export interface Certificates {
  root: RootCertPem;
  leaf: LeafCert;
  /** Set when `root` is a temporary stand-in for a stored root that is locked. */
  temporaryReason?: string;
}

/**
 * Loads the persisted root CA (creating it on first run) and signs a fresh
 * localhost cert. An expired root is kept — replacing it is the user's call
 * (regenerateRoot), because the new one has to be trusted again.
 */
export function ensureCertificates(): Certificates {
  const read = readRootCert();
  if (read.state === 'ok') return { root: read.pem, leaf: generateAndSignCert(read.pem) };
  if (read.state === 'locked') {
    // Never overwrite a root the user may have trusted just because its key
    // is unreadable right now (locked keyring, restored profile).
    log.warn(`stored root CA key unavailable (${read.reason}); using a temporary root`);
    const root = createRootCert();
    return { root, leaf: generateAndSignCert(root), temporaryReason: read.reason };
  }
  const root = createRootCert();
  setRootCertPem(root);
  return { root, leaf: generateAndSignCert(root) };
}

/** Replaces the stored root CA with a new one. Clients must trust it again. */
export function regenerateRoot(): Certificates {
  const root = createRootCert();
  setRootCertPem(root);
  return { root, leaf: generateAndSignCert(root) };
}

export async function exportRootCert(win: BrowserWindow, root: RootCertPem): Promise<void> {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Reversee Root Cert',
    defaultPath: 'reversee.root.pem',
    filters: [
      { name: 'pem', extensions: ['pem'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (!canceled && filePath) {
    await fs.writeFile(filePath, root.certificate, 'utf8');
  }
}

export function certificateTrustDialog(win: BrowserWindow, root: RootCertPem): void {
  void dialog.showCertificateTrustDialog(win, {
    certificate: { data: root.certificate } as Electron.Certificate,
    message:
      "To proxy https clients that can not trust Self Signed Certificates, click 'Show Certificate' and select 'Always Trust.'",
  });
}
