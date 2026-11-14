// Runs user-supplied interceptor JavaScript in a node:vm context. Errors in
// user code never propagate: a broken interceptor must not take the proxy down
// mid-request. They are returned (with any console output) so the UI and MCP
// can show them on the traffic entry.
//
// node:vm isolates SCOPE, not PRIVILEGE. The script cannot see the proxy's
// variables by accident, but it is trivially able to reach the host realm
// (e.g. through a constructor chain) and run arbitrary code in this worker
// process. Interceptors are code the user chose to run; this is not a security
// boundary and must never be treated as one.
import vm from 'node:vm';
import type { Logger, RequestParams } from '../../shared/types';

export interface ResponseParams {
  statusCode?: number;
  headers: Record<string, unknown>;
  body: unknown;
}

export interface InterceptResult {
  /** Message of the error the user code threw (incl. syntax errors and timeouts). */
  error?: string;
  /** console.* output, one formatted line per call. */
  logs: string[];
}

/**
 * Synchronous budget for one interceptor run. Without it a `while (true) {}`
 * wedges the single-threaded worker for every request until it is restarted.
 */
export const INTERCEPTOR_TIMEOUT_MS = 1000;

const MAX_LOG_LINES = 50;
const MAX_LOG_LINE_LENGTH = 2000;

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    const json = JSON.stringify(arg);
    if (json !== undefined) return json;
  } catch {
    // circular or otherwise unserializable — fall through
  }
  return String(arg);
}

function makeConsole(logs: string[]): Record<string, (...args: unknown[]) => void> {
  const write =
    (level: string) =>
    (...args: unknown[]): void => {
      if (logs.length >= MAX_LOG_LINES) return;
      const line = args.map(formatArg).join(' ').slice(0, MAX_LOG_LINE_LENGTH);
      logs.push(level === 'log' ? line : `[${level}] ${line}`);
    };
  return {
    log: write('log'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    debug: write('debug'),
  };
}

function intercept(
  requestParams: RequestParams | null,
  responseParams: ResponseParams | null,
  code: string,
  logger: Logger,
  timeoutMs: number
): InterceptResult {
  const logs: string[] = [];
  try {
    const sandbox = { requestParams, responseParams, console: makeConsole(logs) };
    const script = new vm.Script(code);
    // afterEvaluate drains the context's microtasks inside runInContext, so
    // the timeout also covers promise chains the script starts.
    const context = vm.createContext(sandbox, { microtaskMode: 'afterEvaluate' });
    script.runInContext(context, { timeout: timeoutMs });
    return { logs };
  } catch (e) {
    logger.warn('interceptor error', e);
    const err = e as { code?: string; message?: string };
    const message =
      err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
        ? `interceptor timed out after ${timeoutMs} ms`
        : String(err?.message ?? e);
    return { error: message, logs };
  }
}

export function interceptRequest(
  requestParams: RequestParams,
  code: string,
  logger: Logger = noop,
  timeoutMs: number = INTERCEPTOR_TIMEOUT_MS
): InterceptResult {
  return intercept(requestParams, null, code, logger, timeoutMs);
}

export function interceptResponse(
  responseParams: ResponseParams,
  code: string,
  requestParams: RequestParams,
  logger: Logger = noop,
  timeoutMs: number = INTERCEPTOR_TIMEOUT_MS
): InterceptResult {
  // The request context is passed as a shallow copy so response interceptors
  // can read it without retroactively mutating the recorded request.
  return intercept({ ...requestParams }, responseParams, code, logger, timeoutMs);
}
