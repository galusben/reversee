// Saves captured traffic as mock rules (record and replay). Shared by the
// window's "Record as mocks" action and the record_mocks MCP tool; the
// conversion itself is the pure shared/record-mocks module.
import { getSettings, setSettings } from './settings';
import { mergeRecorded, recordMocks, type RecordOptions } from '../shared/record-mocks';
import type { RecordMocksResult } from '../shared/ipc';
import type { TrafficEntry } from '../shared/types';

export function saveRecordedMocks(
  entries: TrafficEntry[],
  options: RecordOptions = {}
): RecordMocksResult {
  const recording = recordMocks(entries, options);
  const merged = mergeRecorded(getSettings().mocks, recording);
  if (merged.stored.length) setSettings({ mocks: merged.mocks });
  return {
    considered: entries.length,
    created: merged.added,
    replaced: merged.replaced,
    overLimit: merged.overLimit,
    skipped: recording.skipped,
    mocks: merged.stored,
  };
}
