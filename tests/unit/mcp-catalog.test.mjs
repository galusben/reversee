// The app-owned MCP tool catalog (electron-free) and its derived mutating set.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isNewerVersion, parseWaitSeconds } from '../../scripts/check-bridge-version.mjs';
import {
  MCP_TOOL_CATALOG,
  MCP_MUTATING_METHODS,
  RECOMMENDED_BRIDGE_VERSION,
  isOlderVersion,
  buildBridgeAdvisory,
} from '../../src/main/mcp/catalog';

describe('MCP tool catalog', () => {
  it('lists the expected tools', () => {
    const names = MCP_TOOL_CATALOG.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'add_proto_spec',
        'decode_jwt',
        'export_diagnostics',
        'get_config',
        'get_status',
        'get_traffic_entry',
        'list_breakpoints',
        'list_proto_specs',
        'list_traffic',
        'remove_proto_spec',
        'replay_request',
        'restart_proxy',
        'search_traffic',
        'set_interceptor',
        'start_proxy',
        'stop_proxy',
        'summarize_session',
        'update_config',
        'validate_setup',
      ].sort()
    );
  });

  it('every tool has a description and an object JSON schema', () => {
    for (const t of MCP_TOOL_CATALOG) {
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(t.inputSchema.type, t.name).toBe('object');
    }
  });

  it('has no duplicate tool names', () => {
    const names = MCP_TOOL_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('derives the mutating set from the catalog', () => {
    expect([...MCP_MUTATING_METHODS].sort()).toEqual(
      [
        'add_proto_spec',
        'remove_proto_spec',
        'replay_request',
        'restart_proxy',
        'set_interceptor',
        'start_proxy',
        'stop_proxy',
        'update_config',
      ].sort()
    );
    // Read-only tools are not gated.
    expect(MCP_MUTATING_METHODS.has('get_status')).toBe(false);
    expect(MCP_MUTATING_METHODS.has('search_traffic')).toBe(false);
    expect(MCP_MUTATING_METHODS.has('summarize_session')).toBe(false);
    expect(MCP_MUTATING_METHODS.has('decode_jwt')).toBe(false);
  });

  it('recommends a sensible bridge version', () => {
    expect(RECOMMENDED_BRIDGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // The app nags every user whose bridge is older than the recommendation, and
  // they can only upgrade to what npm actually serves. Recommending a version
  // this repo has not even reached means the advisory can never be satisfied.
  // This is the offline half of `npm run check:bridge-version`; the release
  // pipeline runs the online half, which also requires it to be *published*.
  it('never recommends a bridge newer than mcp/package.json', () => {
    const packaged = JSON.parse(
      readFileSync(new URL('../../mcp/package.json', import.meta.url), 'utf8')
    ).version;
    expect(
      isNewerVersion(RECOMMENDED_BRIDGE_VERSION, packaged),
      `app recommends ${RECOMMENDED_BRIDGE_VERSION} but mcp/package.json is ${packaged}`
    ).toBe(false);
  });

  // Guards against a bump leaving a stale version string behind in the text.
  it('derives every version string in the advisory from the constant', () => {
    const note = buildBridgeAdvisory(undefined).note;
    expect(note).toContain(`pre-${RECOMMENDED_BRIDGE_VERSION}`);
    expect(note).toContain(RECOMMENDED_BRIDGE_VERSION);
  });
});

describe('isOlderVersion', () => {
  it('compares release cores numerically, ignoring pre-release tags', () => {
    expect(isOlderVersion('2.0.0', '2.1.0')).toBe(true);
    expect(isOlderVersion('1.9.9', '2.0.0')).toBe(true);
    expect(isOlderVersion('2.1.0', '2.1.0')).toBe(false);
    expect(isOlderVersion('2.2.0', '2.1.0')).toBe(false);
    expect(isOlderVersion('10.0.0', '9.0.0')).toBe(false); // numeric, not lexical
    expect(isOlderVersion('2.1.0-beta.1', '2.1.0')).toBe(false);
  });
});

describe('buildBridgeAdvisory', () => {
  it('treats a missing bridge version (old bridge) as outdated', () => {
    const a = buildBridgeAdvisory(undefined);
    expect(a.upToDate).toBe(false);
    expect(a.note).toMatch(/reversee-mcp/);
    expect(a.note).toMatch(/_npx/); // surgical upgrade command
  });

  it('flags a bridge older than recommended', () => {
    const a = buildBridgeAdvisory('2.0.0');
    expect(a.upToDate).toBe(false);
    expect(a.recommended).toBe(RECOMMENDED_BRIDGE_VERSION);
    expect(a.reportedVersion).toBe('2.0.0');
  });

  it('is clean for a current or newer bridge', () => {
    expect(buildBridgeAdvisory(RECOMMENDED_BRIDGE_VERSION).upToDate).toBe(true);
    expect(buildBridgeAdvisory('99.0.0').upToDate).toBe(true);
    expect(buildBridgeAdvisory(RECOMMENDED_BRIDGE_VERSION).note).toBeUndefined();
  });
});

// npm returns from a publish before the version is readable, so the release
// pipeline polls instead of reading once. Fail-fast stays the default for a
// human running the check by hand.
describe('parseWaitSeconds', () => {
  it('does not wait unless asked', () => {
    expect(parseWaitSeconds(['node', 'check.mjs'])).toBe(0);
    expect(parseWaitSeconds(['node', 'check.mjs', '--offline'])).toBe(0);
  });

  it('defaults to 300s for a bare --wait, and honours an explicit value', () => {
    expect(parseWaitSeconds(['node', 'check.mjs', '--wait'])).toBe(300);
    expect(parseWaitSeconds(['node', 'check.mjs', '--wait=120'])).toBe(120);
    expect(parseWaitSeconds(['node', 'check.mjs', '--wait=0'])).toBe(0);
  });

  it('rejects a nonsense value rather than silently not waiting', () => {
    expect(() => parseWaitSeconds(['node', 'check.mjs', '--wait=soon'])).toThrow(/invalid --wait/);
    expect(() => parseWaitSeconds(['node', 'check.mjs', '--wait=-5'])).toThrow(/invalid --wait/);
  });
});
