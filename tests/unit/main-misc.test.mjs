// Small main-process pieces: the client-certificate loader, the external-link
// allowlist, the traffic store's cap/update semantics, and replay options.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startUpstream, closeAll } from './helpers.mjs';

vi.mock('electron', () => ({ BrowserWindow: class {}, nativeImage: {}, shell: {} }));
vi.mock('electron-window-state', () => ({ default: () => ({}) }));
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));
vi.mock('../../resources/icon.png?asset', () => ({ default: 'icon.png' }));

const { readClientCert } = await import('../../src/main/client-cert');
const { isAllowedExternalLink } = await import('../../src/main/windows');
const { TrafficStore } = await import('../../src/main/traffic-store');
const { replayRequest, replayEntry } = await import('../../src/main/replay');
const { defaultSettings } = await import('../../src/shared/settings-schema');

let openServers = [];
afterEach(async () => {
  await closeAll(...openServers);
  openServers = [];
});

describe('readClientCert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversee-clientcert-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  fs.writeFileSync(cert, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
  fs.writeFileSync(key, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
  const cfg = (c, k) => ({ upstreamClientCertPath: c, upstreamClientKeyPath: k });

  it('is undefined when nothing is configured', () => {
    expect(readClientCert(cfg('', '  '))).toBeUndefined();
  });

  it('reads both PEM files', () => {
    const result = readClientCert(cfg(cert, ` ${key} `));
    expect(result.cert).toContain('BEGIN CERTIFICATE');
    expect(result.key).toContain('BEGIN PRIVATE KEY');
  });

  it('accepts RSA and EC key headers', () => {
    const rsa = path.join(dir, 'rsa.pem');
    fs.writeFileSync(rsa, '-----BEGIN RSA PRIVATE KEY-----\nabc\n');
    expect(readClientCert(cfg(cert, rsa)).key).toContain('RSA PRIVATE KEY');
  });

  it('explains what is wrong instead of silently going without', () => {
    expect(() => readClientCert(cfg(cert, ''))).toThrow(/both a certificate file and a key file/);
    expect(() => readClientCert(cfg(path.join(dir, 'missing.pem'), key))).toThrow(
      /certificate: cannot read .*missing\.pem \(ENOENT\)/
    );
    // Swapped files are a common mistake.
    expect(() => readClientCert(cfg(key, cert))).toThrow(/is not a PEM certificate/);
    expect(() => readClientCert(cfg(cert, cert))).toThrow(/is not a PEM key/);
  });
});

describe('external link allowlist', () => {
  it('allows the repository and paths under it', () => {
    expect(isAllowedExternalLink('https://github.com/galusben/reversee')).toBe(true);
    expect(isAllowedExternalLink('https://github.com/galusben/reversee/releases')).toBe(true);
    expect(isAllowedExternalLink('https://github.com/galusben/reversee#readme')).toBe(true);
    expect(isAllowedExternalLink('https://github.com/galusben/reversee?tab=readme')).toBe(true);
  });

  it('rejects look-alike prefixes and other sites', () => {
    expect(isAllowedExternalLink('https://github.com/galusben/reversee-evil')).toBe(false);
    expect(isAllowedExternalLink('https://github.com/galusben/reversee.attacker.io')).toBe(false);
    expect(isAllowedExternalLink('https://github.com/galusben')).toBe(false);
    expect(isAllowedExternalLink('https://evil.test/https://github.com/galusben/reversee')).toBe(
      false
    );
  });
});

describe('TrafficStore cap and updates', () => {
  const entry = (extra = {}) => ({
    trafficId: 0,
    request: { url: '/', method: 'GET', headers: {} },
    response: { headers: {} },
    timings: { start: 'x' },
    ...extra,
  });

  it('setCap evicts the oldest entries immediately and applies to later adds', () => {
    const store = new TrafficStore(10);
    for (let i = 0; i < 6; i++) store.add(entry());
    store.setCap(3);
    expect(store.getAll().map((e) => e.trafficId)).toEqual([4, 5, 6]);
    store.add(entry());
    expect(store.getAll().map((e) => e.trafficId)).toEqual([5, 6, 7]);
    store.setCap(100);
    expect(store.size).toBe(3);
  });

  it('update replaces in place and refuses to resurrect an evicted entry', () => {
    const store = new TrafficStore(2);
    const first = store.add(entry({ pending: true }));
    store.add(entry());
    const updated = store.update({
      ...entry({ response: { statusCode: 200, headers: {} } }),
      trafficId: first.trafficId,
    });
    expect(updated.response.statusCode).toBe(200);
    expect(store.get(first.trafficId).pending).toBeUndefined();
    expect(store.size).toBe(2);

    store.add(entry()); // evicts `first`
    expect(store.update({ ...entry(), trafficId: first.trafficId })).toBeUndefined();
    expect(store.size).toBe(2);
    expect(store.get(first.trafficId)).toBeUndefined();
  });
});

describe('replay options', () => {
  const source = (port, extra = {}) => ({
    target: { protocol: 'http', host: '127.0.0.1', port },
    method: 'POST',
    url: '/r',
    headers: { 'content-length': '3', 'content-type': 'text/plain' },
    body: Buffer.from('abc'),
    ...extra,
  });

  it('resyncs content-length when the body is replaced', async () => {
    let seen;
    const upstream = await startUpstream((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen = { length: req.headers['content-length'], body: Buffer.concat(chunks).toString() };
        res.end('ok');
      });
    });
    openServers.push(upstream.server);
    const entry = await replayRequest(source(upstream.port), { body: 'a longer body' }, false);
    expect(seen).toEqual({ length: '13', body: 'a longer body' });
    expect(entry.request.size).toBe(13);
    expect(entry.response.size).toBe(2);
    expect(entry.replay).toBe(true);
  });

  it('gives up after the timeout instead of hanging', async () => {
    const upstream = await startUpstream(() => {});
    openServers.push(upstream.server);
    const entry = await replayRequest(source(upstream.port), {}, false, { timeoutMs: 150 });
    expect(entry.response.statusCode).toBe(502);
    expect(String(entry.connectorError)).toMatch(/no response from the upstream within 0\.15 s/);
  });

  it('replayEntry uses the stored target and current settings, and rejects targetless entries', async () => {
    const upstream = await startUpstream((req, res) => res.end(`saw ${req.url}`));
    openServers.push(upstream.server);
    const stored = {
      trafficId: 3,
      request: {
        url: '/orig',
        method: 'GET',
        headers: {},
        target: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
      },
      response: { headers: {} },
      timings: { start: 'x' },
    };
    const replayed = await replayEntry(stored, { url: '/again' }, defaultSettings);
    expect(Buffer.from(replayed.response.body).toString()).toBe('saw /again');

    const mocked = { ...stored, request: { ...stored.request, target: undefined } };
    await expect(replayEntry(mocked, {}, defaultSettings)).rejects.toThrow(
      /no recorded upstream target/
    );
    await expect(
      replayEntry(
        stored,
        {},
        {
          ...defaultSettings,
          upstreamClientCertPath: '/nope.pem',
          upstreamClientKeyPath: '/nope.key',
        }
      )
    ).rejects.toThrow(/cannot read \/nope.pem/);
  });
});
