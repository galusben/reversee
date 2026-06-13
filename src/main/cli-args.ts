// Launch flags, mainly for agents running Reversee without the UI.
//
//   reversee --headless --allow-mcp-control
//
// Flags are session overrides: they do not change the user's saved settings.

export interface CliFlags {
  /** Run with no window/dock; the app lives on the MCP control socket until killed. */
  headless: boolean;
  /** Launch-time equivalent of "Allow MCP to Control the Proxy" (start/stop/config). */
  allowMcpControl: boolean;
  /** Explicit MCP socket override; undefined = use the saved setting. Headless defaults to on. */
  mcp?: boolean;
}

export function parseCliFlags(argv: readonly string[]): CliFlags {
  const has = (flag: string): boolean => argv.includes(flag);
  const headless = has('--headless');
  return {
    headless,
    allowMcpControl: has('--allow-mcp-control'),
    // --no-mcp wins; then --allow-mcp; otherwise headless implies on, GUI uses the saved setting.
    mcp: has('--no-mcp') ? false : has('--allow-mcp') || headless ? true : undefined,
  };
}
