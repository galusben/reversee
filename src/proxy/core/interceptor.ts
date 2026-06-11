// Runs user-supplied interceptor JavaScript in a vm sandbox. Errors in user
// code are swallowed by design: a broken interceptor must never take the
// proxy down mid-request.
import vm from 'node:vm';
import type { Logger, RequestParams } from '../../shared/types';

interface ResponseParams {
  statusCode?: number;
  headers: Record<string, unknown>;
  body: unknown;
}

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function intercept(
  requestParams: RequestParams | null,
  responseParams: ResponseParams | null,
  code: string,
  logger: Logger
): void {
  try {
    const sandbox = { requestParams, responseParams };
    const script = new vm.Script(code);
    const context = vm.createContext(sandbox);
    script.runInContext(context);
  } catch (e) {
    logger.warn('interceptor error', e);
  }
}

export function interceptRequest(
  requestParams: RequestParams,
  code: string,
  logger: Logger = noop
): void {
  intercept(requestParams, null, code, logger);
}

export function interceptResponse(
  responseParams: ResponseParams,
  code: string,
  requestParams: RequestParams,
  logger: Logger = noop
): void {
  // The request context is passed as a shallow copy so response interceptors
  // can read it without retroactively mutating the recorded request.
  intercept({ ...requestParams }, responseParams, code, logger);
}
