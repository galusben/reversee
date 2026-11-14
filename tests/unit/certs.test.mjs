// Root CA + localhost leaf generation (src/main/certs/certs.ts). The root is
// persisted once and reused; the leaf is re-signed every boot. Verified both
// structurally (node-forge) and end to end (a real TLS handshake that trusts
// only the generated root).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import forge from 'node-forge';
import https from 'node:https';

let storedRoot;
// When set, the stored root exists but its key cannot be read (locked keychain).
let lockedReason;
const persisted = [];

vi.mock('electron', () => ({ dialog: {} }));
vi.mock('electron-log', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('../../src/main/settings', () => ({
  readRootCert: () => {
    if (lockedReason)
      return { state: 'locked', certificate: storedRoot.certificate, reason: lockedReason };
    return storedRoot ? { state: 'ok', pem: storedRoot } : { state: 'missing' };
  },
  setRootCertPem: (pem) => {
    persisted.push(pem);
    storedRoot = pem;
  },
}));

const { ensureCertificates, regenerateRoot, rootCertStatus, ROOT_VALIDITY_YEARS } =
  await import('../../src/main/certs/certs');

// RSA-2048 generation is slow in pure JS; generate once and share.
let first;
beforeAll(() => {
  storedRoot = undefined;
  first = ensureCertificates();
}, 60_000);

beforeEach(() => {
  storedRoot = first.root;
  lockedReason = undefined;
  persisted.length = 0;
});

const DAY = 24 * 60 * 60 * 1000;

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
    // Clients that connect by address need IP SANs.
    expect(altNames).toContainEqual(expect.objectContaining({ type: 7, ip: '127.0.0.1' }));
    expect(altNames.filter((n) => n.type === 7)).toHaveLength(2); // + ::1
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

  it('accepts a client that connects by IP address', async () => {
    const server = https.createServer(
      { key: first.leaf.privateKey, cert: first.leaf.certificate },
      (_req, res) => res.end('by ip')
    );
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const body = await new Promise((resolve, reject) => {
        https
          // No servername: the certificate is checked against 127.0.0.1 itself.
          .get({ host: '127.0.0.1', port, ca: first.root.certificate }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve(data));
          })
          .on('error', reject);
      });
      expect(body).toBe('by ip');
    } finally {
      server.close();
    }
  });
});

describe('certificate hygiene', () => {
  it('issues the leaf as an end-entity certificate, not a CA', () => {
    const leaf = forge.pki.certificateFromPem(first.leaf.certificate);
    expect(leaf.getExtension('basicConstraints').cA).toBe(false);
    const usage = leaf.getExtension('keyUsage');
    expect(usage.keyCertSign).toBe(false);
    expect(usage.digitalSignature).toBe(true);
    expect(leaf.getExtension('extKeyUsage').serverAuth).toBe(true);
  });

  it('uses unique, positive serial numbers', () => {
    const root = forge.pki.certificateFromPem(first.root.certificate);
    const leaf = forge.pki.certificateFromPem(first.leaf.certificate);
    const again = forge.pki.certificateFromPem(ensureCertificates().leaf.certificate);
    const serials = [root.serialNumber, leaf.serialNumber, again.serialNumber];
    expect(new Set(serials).size).toBe(3);
    for (const serial of serials) {
      expect(serial).toMatch(/^[0-7][0-9a-f]{31}$/);
    }
  }, 30_000);

  it('makes the root long-lived and never lets the leaf outlive it', () => {
    const root = forge.pki.certificateFromPem(first.root.certificate);
    const leaf = forge.pki.certificateFromPem(first.leaf.certificate);
    const years = (root.validity.notAfter.getTime() - Date.now()) / (365 * DAY);
    expect(years).toBeGreaterThan(ROOT_VALIDITY_YEARS - 0.1);
    expect(leaf.validity.notAfter.getTime()).toBeLessThanOrEqual(root.validity.notAfter.getTime());
    // Backdated, so a client with a slow clock still accepts it.
    expect(leaf.validity.notBefore.getTime()).toBeLessThan(Date.now() - DAY / 2);
  });
});

describe('rootCertStatus', () => {
  it('reports a healthy root', () => {
    const status = rootCertStatus(first.root);
    expect(status.expired).toBe(false);
    expect(status.expiringSoon).toBe(false);
    expect(status.daysLeft).toBeGreaterThan(3600);
    expect(new Date(status.notAfter).getTime()).toBeGreaterThan(Date.now());
  });

  it('warns inside the 30-day window and flags expiry', () => {
    const notAfter = forge.pki
      .certificateFromPem(first.root.certificate)
      .validity.notAfter.getTime();
    const soon = rootCertStatus(first.root, notAfter - 10 * DAY);
    expect(soon).toMatchObject({ expired: false, expiringSoon: true, daysLeft: 10 });
    const gone = rootCertStatus(first.root, notAfter + 3 * DAY);
    expect(gone).toMatchObject({ expired: true, expiringSoon: true, daysLeft: -3 });
  });
});

describe('root lifecycle', () => {
  it('does not overwrite a stored root whose key is locked; uses a temporary one', () => {
    lockedReason = 'keychain locked';
    const result = ensureCertificates();
    expect(result.temporaryReason).toBe('keychain locked');
    expect(result.root.certificate).not.toBe(first.root.certificate);
    expect(persisted).toHaveLength(0); // the trusted root on disk is untouched
    const tempRoot = forge.pki.certificateFromPem(result.root.certificate);
    expect(tempRoot.verify(forge.pki.certificateFromPem(result.leaf.certificate))).toBe(true);
  }, 30_000);

  it('regenerateRoot persists a new root and signs the leaf with it', () => {
    const result = regenerateRoot();
    expect(result.root.certificate).not.toBe(first.root.certificate);
    expect(persisted).toEqual([result.root]);
    const root = forge.pki.certificateFromPem(result.root.certificate);
    expect(root.verify(forge.pki.certificateFromPem(result.leaf.certificate))).toBe(true);
    expect(result.temporaryReason).toBeUndefined();
  }, 30_000);
});
