// Bridge catalog resolution + version-advisory logic, plus an integration
// check of resolveCatalog against the real control-server implementation.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../../src/main/mcp/control-server';
import { ReverseeClient } from '../../mcp/src/client';
import { resolveCatalog, FALLBACK_CATALOG } from '../../mcp/src/catalog';

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
