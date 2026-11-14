// Breakpoint rule compilation and matching. Rules are compiled once when set;
// invalid regular expressions are reported back instead of throwing on every
// incoming request (which is what the original per-request `new RegExp` did).
import type { BreakpointCompileError, BreakpointPhase, BreakpointRule } from '../../shared/types';

export type { BreakpointCompileError };

export interface CompiledBreakpoint {
  id: string;
  path: string;
  methods: string[];
  phase: BreakpointPhase;
  regex: RegExp;
}

export interface CompiledBreakpoints {
  compiled: CompiledBreakpoint[];
  errors: BreakpointCompileError[];
}

export function compileBreakpoints(rules: BreakpointRule[]): CompiledBreakpoints {
  const compiled: CompiledBreakpoint[] = [];
  const errors: BreakpointCompileError[] = [];
  for (const rule of rules) {
    try {
      compiled.push({
        id: rule.id,
        path: rule.path,
        methods: rule.methods,
        phase: rule.phase === 'response' ? 'response' : 'request',
        regex: new RegExp(rule.path),
      });
    } catch (e) {
      errors.push({ id: rule.id, path: rule.path, error: (e as Error).message });
    }
  }
  return { compiled, errors };
}

export function matchBreakpoint(
  breakpoints: CompiledBreakpoint[],
  url: string,
  method: string,
  phase: BreakpointPhase = 'request'
): CompiledBreakpoint | null {
  for (const breakpoint of breakpoints) {
    if (
      breakpoint.phase === phase &&
      breakpoint.methods.includes(method) &&
      breakpoint.regex.test(url)
    ) {
      return breakpoint;
    }
  }
  return null;
}
