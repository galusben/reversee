// Root CA + localhost leaf generation (src/main/certs/certs.ts). The root is
// persisted once and reused; the leaf is re-signed every boot. Verified both
// structurally (node-forge) and end to end (a real TLS handshake that trusts
// only the generated root).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import forge from 'node-forge';
import https from 'node:https';

let storedRoot;

vi.mock('electron', () => ({ dialog: {} }));
vi.mock('electron-log', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('../../src/main/settings', () => ({
  getRootCertPem: () => storedRoot,
  setRootCertPem: (pem) => {
    storedRoot = pem;
  },
}));

const { ensureCertificates } = await import('../../src/main/certs/certs');

// RSA-2048 generation is slow in pure JS; generate once and share.
let first;
beforeAll(() => {
  storedRoot = undefined;
  first = ensureCertificates();
}, 60_000);

beforeEach(() => {
  storedRoot = first.root;
});

describe('ensureCertificates', () => {
  it('creates and persists a root CA on first run', () => {
    expect(storedRoot).toBe(first.root);
    const root = forge.pki.certificateFromPem(first.root.certificate);
    expect(root.getExtension('basicConstraints').cA).toBe(true);
    expect(root.subject.getField('CN').value).toBe('reversee.ninja');
    // Self-signed.
    expect(root.verify(root)).toBe(true);
    // The persisted key pair matches the certificate.
    const key = forge.pki.privateKeyFromPem(first.root.privateKey);
    expect(key.n.equals(root.publicKey.n)).toBe(true);
  });

  it('signs a localhost leaf with the root', () => {
    const root = forge.pki.certificateFromPem(first.root.certificate);
    const leaf = forge.pki.certificateFromPem(first.leaf.certificate);
    expect(leaf.subject.getField('CN').value).toBe('localhost');
    expect(leaf.issuer.getField('CN').value).toBe('reversee.ninja');
    expect(root.verify(leaf)).toBe(true);
    const altNames = leaf.getExtension('subjectAltName').altNames;
    expect(altNames).toContainEqual(expect.objectContaining({ type: 2, value: 'localhost' }));
    const now = Date.now();
    expect(leaf.validity.notBefore.getTime()).toBeLessThanOrEqual(now);
    expect(leaf.validity.notAfter.getTime()).toBeGreaterThan(now);
  });

  it('reuses the stored root and issues a fresh leaf on the next boot', () => {
    const second = ensureCertificates();
    expect(second.root).toBe(first.root);
    expect(second.leaf.certificate).not.toBe(first.leaf.certificate);
    const root = forge.pki.certificateFromPem(first.root.certificate);
    expect(root.verify(forge.pki.certificateFromPem(second.leaf.certificate))).toBe(true);
  }, 30_000);

  it('serves TLS that a client trusting only the root accepts', async () => {
    const server = https.createServer(
      { key: first.leaf.privateKey, cert: first.leaf.certificate },
      (_req, res) => res.end('secure')
    );
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const body = await new Promise((resolve, reject) => {
        https
          .get(
            {
              host: '127.0.0.1',
              port,
              servername: 'localhost',
              ca: first.root.certificate,
              rejectUnauthorized: true,
            },
            (res) => {
              let data = '';
              res.on('data', (c) => (data += c));
              res.on('end', () => resolve(data));
            }
          )
          .on('error', reject);
      });
      expect(body).toBe('secure');
    } finally {
      server.close();
    }
  });
});
