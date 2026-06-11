// Breakpoint rule compilation and matching. Rules are compiled once when set;
// invalid regular expressions are reported back instead of throwing on every
// incoming request (which is what the original per-request `new RegExp` did).
import type { BreakpointRule } from '../../shared/types';

export interface CompiledBreakpoint {
  id: string;
  path: string;
  methods: string[];
  regex: RegExp;
}

export interface BreakpointCompileError {
  id: string;
  path: string;
  error: string;
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
  method: string
): CompiledBreakpoint | null {
  for (const breakpoint of breakpoints) {
    if (breakpoint.methods.includes(method) && breakpoint.regex.test(url)) {
      return breakpoint;
    }
  }
  return null;
}
