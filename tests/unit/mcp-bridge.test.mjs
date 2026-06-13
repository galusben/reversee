// Bridge catalog resolution + version-advisory logic, plus an integration
// check of resolveCatalog against the real control-server implementation.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../../src/main/mcp/control-server';
import { ReverseeClient } from '../../mcp/src/client';
import {
  resolveCatalog,
  versionAdvisory,
  isOlder,
  FALLBACK_CATALOG,
} from '../../mcp/src/catalog';

describe('isOlder', () => {
  it('compares release cores numerically', () => {
    expect(isOlder('2.0.0', '2.1.0')).toBe(true);
    expect(isOlder('2.0.0', '2.0.1')).toBe(true);
    expect(isOlder('1.9.9', '2.0.0')).toBe(true);
    expect(isOlder('2.0.0', '2.0.0')).toBe(false);
    expect(isOlder('2.1.0', '2.0.0')).toBe(false);
    expect(isOlder('10.0.0', '9.0.0')).toBe(false); // numeric, not lexical
  });

  it('ignores pre-release suffixes', () => {
    expect(isOlder('2.0.0-beta.1', '2.0.0')).toBe(false);
  });
});

describe('versionAdvisory', () => {
  it('flags an out-of-date bridge with an upgrade note', () => {
    const a = versionAdvisory('2.0.0', '2.1.0');
    expect(a.upToDate).toBe(false);
    expect(a.recommended).toBe('2.1.0');
    expect(a.note).toMatch(/reversee-mcp/);
    expect(a.note).toMatch(/_npx/); // contains the surgical refresh command
  });

  it('reports up to date when current or ahead', () => {
    expect(versionAdvisory('2.1.0', '2.1.0').upToDate).toBe(true);
    expect(versionAdvisory('2.2.0', '2.1.0').upToDate).toBe(true);
  });

  it('reports up to date when the app gives no recommendation (offline)', () => {
    expect(versionAdvisory('2.0.0', undefined).upToDate).toBe(true);
  });
});

describe('resolveCatalog', () => {
  let dir;
  let server;

  afterEach(async () => {
    await server?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    server = undefined;
  });

  it('uses the app catalog when the app is reachable', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-cat-'));
    server = await startControlServer({
      dir,
      appVersion: '0.0.0-test',
      isControlAllowed: () => false,
      mutatingMethods: new Set(),
      handlers: {
        list_tools: () => ({
          tools: [{ name: 'demo_tool', description: 'x', inputSchema: { type: 'object' } }],
          recommendedBridge: '2.5.0',
        }),
      },
    });
    const res = await resolveCatalog(new ReverseeClient(dir));
    expect(res.fromApp).toBe(true);
    expect(res.tools.map((t) => t.name)).toEqual(['demo_tool']);
    expect(res.recommendedBridge).toBe('2.5.0');
  });

  it('falls back to the embedded catalog when the app is down', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-cat-empty-'));
    const res = await resolveCatalog(new ReverseeClient(emptyDir));
    expect(res.fromApp).toBe(false);
    expect(res.tools).toBe(FALLBACK_CATALOG);
    expect(res.recommendedBridge).toBeUndefined();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});
