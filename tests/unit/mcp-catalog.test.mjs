// The app-owned MCP tool catalog (electron-free) and its derived mutating set.
import { describe, it, expect } from 'vitest';
import {
  MCP_TOOL_CATALOG,
  MCP_MUTATING_METHODS,
  RECOMMENDED_BRIDGE_VERSION,
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
