// Stable breakpoint rule ids, shared by the UI and the MCP set_breakpoints tool.
import type { BreakpointPhase } from './types';

/**
 * Methods are sorted so [GET,POST] and [POST,GET] dedupe (the 1.x id
 * concatenated methods unsorted and created duplicates). Request-phase ids
 * keep their pre-2.3 form; response-phase ids are prefixed.
 */
export function ruleId(
  path: string,
  methods: string[],
  phase: BreakpointPhase = 'request'
): string {
  const id = [...methods].sort().join(',') + ' ' + path;
  return phase === 'response' ? `response ${id}` : id;
}
