// Dry run of an interceptor script against a captured exchange, for the
// Scripts screen and the try_interceptor MCP tool. The script runs in the
// proxy worker, like live scripts do; nothing is sent, saved or recorded.
import type { ScriptTrialOutcome } from '../shared/ipc';
import { describeTrialChanges, exchangeFromEntry } from '../shared/script-trial';
import type { ProxyHost } from './proxy-host';
import type { TrafficStore } from './traffic-store';
import type { AppSettings } from '../shared/settings-schema';

const MAX_CODE_LENGTH = 200_000;

export async function runScriptTrial(
  proxyHost: Pick<ProxyHost, 'tryScript'>,
  trafficStore: Pick<TrafficStore, 'get'>,
  kind: unknown,
  code: unknown,
  trafficId: unknown,
  /** The settings of the tab the request belongs to. */
  settings: AppSettings
): Promise<ScriptTrialOutcome> {
  if (kind !== 'request' && kind !== 'response') {
    return { ok: false, error: 'kind must be "request" or "response"' };
  }
  if (typeof code !== 'string' || code.length > MAX_CODE_LENGTH) {
    return { ok: false, error: 'code must be a string of JavaScript' };
  }
  const entry = typeof trafficId === 'number' ? trafficStore.get(trafficId) : undefined;
  if (!entry) return { ok: false, error: 'That request is no longer in the list.' };

  const exchange = exchangeFromEntry(entry, settings);
  const before = kind === 'request' ? { request: exchange.request } : exchange;
  try {
    const { error, logs, ...after } = await proxyHost.tryScript({ kind, code, ...before });
    return { ok: true, before, after, changes: describeTrialChanges(before, after), error, logs };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
