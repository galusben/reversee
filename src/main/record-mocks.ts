// Saves captured traffic as mock rules (record and replay). Shared by the
// window's "Record as mocks" action and the record_mocks MCP tool; the
// conversion itself is the pure shared/record-mocks module.
import { getSettings, setSettings } from './settings';
import { mergeRecorded, recordMocks, type RecordOptions } from '../shared/record-mocks';
import type { RecordMocksResult } from '../shared/ipc';
import type { TrafficEntry } from '../shared/types';

export function saveRecordedMocks(
  entries: TrafficEntry[],
  options: RecordOptions = {},
  /** The tab whose mocks receive them (default: the active tab). */
  tabId?: string
): RecordMocksResult {
  return record(entries, options, tabId, true);
}

/**
 * What saveRecordedMocks would do, without saving. The window's preview runs
 * here because the window no longer holds the bodies. Mock bodies are left
 * out of the result: the preview lists rules, it does not show them.
 */
export function previewRecordedMocks(
  entries: TrafficEntry[],
  options: RecordOptions = {},
  tabId?: string
): RecordMocksResult {
  const result = record(entries, options, tabId, false);
  return { ...result, mocks: result.mocks.map((m) => ({ ...m, rule: { ...m.rule, body: '' } })) };
}

function record(
  entries: TrafficEntry[],
  options: RecordOptions,
  tabId: string | undefined,
  save: boolean
): RecordMocksResult {
  const recording = recordMocks(entries, options);
  const merged = mergeRecorded(getSettings(tabId).mocks, recording);
  if (save && merged.stored.length) setSettings({ mocks: merged.mocks }, tabId);
  return {
    considered: entries.length,
    created: merged.added,
    replaced: merged.replaced,
    overLimit: merged.overLimit,
    skipped: recording.skipped,
    mocks: merged.stored,
  };
}
