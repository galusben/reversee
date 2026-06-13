// The app-owned MCP tool catalog (electron-free) and its derived mutating set.
import { describe, it, expect } from 'vitest';
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
        'export_diagnostics',
        'get_config',
        'get_status',
        'get_traffic_entry',
        'list_breakpoints',
        'list_traffic',
        'restart_proxy',
        'start_proxy',
        'stop_proxy',
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
      ['restart_proxy', 'start_proxy', 'stop_proxy', 'update_config'].sort()
    );
    // Read-only tools are not gated.
    expect(MCP_MUTATING_METHODS.has('get_status')).toBe(false);
    expect(MCP_MUTATING_METHODS.has('list_traffic')).toBe(false);
  });

  it('recommends a sensible bridge version', () => {
    expect(RECOMMENDED_BRIDGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
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
