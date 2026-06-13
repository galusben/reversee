import { describe, it, expect } from 'vitest';
import { parseCliFlags } from '../../src/main/cli-args';

describe('parseCliFlags', () => {
  it('defaults to GUI mode with no overrides', () => {
    const f = parseCliFlags(['/path/electron', 'index.js']);
    expect(f.headless).toBe(false);
    expect(f.allowMcpControl).toBe(false);
    expect(f.mcp).toBeUndefined(); // use saved setting
  });

  it('headless implies MCP enabled', () => {
    const f = parseCliFlags(['x', '--headless']);
    expect(f.headless).toBe(true);
    expect(f.mcp).toBe(true);
  });

  it('parses the control opt-in', () => {
    expect(parseCliFlags(['x', '--headless', '--allow-mcp-control']).allowMcpControl).toBe(true);
    expect(parseCliFlags(['x', '--headless']).allowMcpControl).toBe(false);
  });

  it('--no-mcp overrides everything, even headless', () => {
    expect(parseCliFlags(['x', '--headless', '--no-mcp']).mcp).toBe(false);
    expect(parseCliFlags(['x', '--allow-mcp', '--no-mcp']).mcp).toBe(false);
  });

  it('--allow-mcp forces the socket on in GUI mode', () => {
    expect(parseCliFlags(['x', '--allow-mcp']).mcp).toBe(true);
  });
});
