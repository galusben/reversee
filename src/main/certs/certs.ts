// Root CA + per-boot localhost certificate generation (node-forge port of the
// legacy src/certs modules, minus the console.log of private keys). The root
// CA persists in the settings store; the localhost leaf is regenerated and
// signed on every boot, exactly as before.
import forge from 'node-forge';
import fs from 'node:fs/promises';
import { dialog, type BrowserWindow } from 'electron';
import log from 'electron-log';
import { getRootCertPem, setRootCertPem, type RootCertPem } from '../settings';

const SUBJECT_ATTRS = [
  { name: 'commonName', value: 'reversee.ninja' },
  { name: 'countryName', value: 'US' },
  { shortName: 'ST', value: 'Virginia' },
  { name: 'localityName', value: 'Blacksburg' },
  { name: 'organizationName', value: 'Reversee' },
  { shortName: 'OU', value: 'Reversee Web Debugger' },
];

export function createRootCert(): RootCertPem {
  log.info('generating root CA key pair...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject(SUBJECT_ATTRS);
  cert.setIssuer(SUBJECT_ATTRS);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true,
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
      clientAuth: true,
      codeSigning: true,
      emailProtection: true,
      timeStamping: true,
    },
    {
      name: 'nsCertType',
      client: true,
      server: true,
      email: true,
      objsign: true,
      sslCA: true,
      emailCA: true,
      objCA: true,
    },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 6, value: 'http://reversee.ninja' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
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

export function generateAndSignCert(root: RootCertPem): LeafCert {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: 'commonName', value: 'localhost' },
    { name: 'countryName', value: 'US' },
    { shortName: 'ST', value: 'Virginia' },
    { name: 'localityName', value: 'Blacksburg' },
    { name: 'organizationName', value: 'Reversee' },
    { shortName: 'OU', value: 'Reversee Web Debugger' },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  const caCert = forge.pki.certificateFromPem(root.certificate);
  const caKey = forge.pki.privateKeyFromPem(root.privateKey);

  const cert = forge.pki.createCertificate();
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  cert.setSubject(csr.subject.attributes);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true,
    },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 6, value: 'http://example.org/webid#me' },
        { type: 2, value: 'localhost' },
      ],
    },
  ]);
  cert.publicKey = csr.publicKey;
  cert.sign(caKey, forge.md.sha256.create());
  log.info('localhost certificate signed');

  return {
    certificate: forge.pki.certificateToPem(cert),
    privateKey: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** Loads the persisted root CA (creating it on first run) and signs a fresh localhost cert. */
export function ensureCertificates(): { root: RootCertPem; leaf: LeafCert } {
  let root = getRootCertPem();
  if (!root) {
    root = createRootCert();
    setRootCertPem(root);
  }
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
