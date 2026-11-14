// Route and mock rules: compiled once per proxy start, matched per request.
// A rule whose regular expression does not compile is skipped (and logged)
// rather than throwing on every request — the settings layer already rejects
// invalid patterns, so this only guards hand-edited config.
import type { Logger, MockRule, ProxySettings, RouteRule } from '../../shared/types';

export interface CompiledRoute {
  rule: RouteRule;
  host?: RegExp;
  path?: RegExp;
}

export interface CompiledMock {
  rule: MockRule;
  path: RegExp;
}

export interface CompiledRules {
  routes: CompiledRoute[];
  mocks: CompiledMock[];
}

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export const NO_RULES: CompiledRules = { routes: [], mocks: [] };

export function compileRules(
  settings: Pick<ProxySettings, 'routes' | 'mocks'>,
  logger: Logger = noop
): CompiledRules {
  const routes: CompiledRoute[] = [];
  for (const rule of settings.routes ?? []) {
    if (!rule.enabled) continue;
    try {
      routes.push({
        rule,
        host: rule.hostPattern ? new RegExp(rule.hostPattern, 'i') : undefined,
        path: rule.pathPattern ? new RegExp(rule.pathPattern) : undefined,
      });
    } catch (e) {
      logger.warn(`route rule ${rule.id} skipped: invalid pattern`, e);
    }
  }
  const mocks: CompiledMock[] = [];
  for (const rule of settings.mocks ?? []) {
    if (!rule.enabled) continue;
    try {
      mocks.push({ rule, path: new RegExp(rule.pathPattern) });
    } catch (e) {
      logger.warn(`mock rule ${rule.id} skipped: invalid pattern`, e);
    }
  }
  return { routes, mocks };
}

/** Host header without the port ("example.com:8080" -> "example.com", "[::1]:80" -> "[::1]"). */
export function hostWithoutPort(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  return hostHeader.replace(/:\d+$/, '');
}

/** The first enabled route whose host and path patterns both match, if any. */
export function matchRoute(
  rules: CompiledRules,
  hostHeader: string | undefined,
  url: string
): RouteRule | null {
  if (rules.routes.length === 0) return null;
  const host = hostWithoutPort(hostHeader);
  for (const route of rules.routes) {
    if (route.host && !route.host.test(host)) continue;
    if (route.path && !route.path.test(url)) continue;
    return route.rule;
  }
  return null;
}

/** The first enabled mock matching the method and URL, if any. */
export function matchMock(rules: CompiledRules, method: string, url: string): MockRule | null {
  for (const mock of rules.mocks) {
    if (mock.rule.method && mock.rule.method !== method.toUpperCase()) continue;
    if (mock.path.test(url)) return mock.rule;
  }
  return null;
}
