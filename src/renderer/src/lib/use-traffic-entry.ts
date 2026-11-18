// The full traffic entry (bodies, curl) behind a list row. The window's
// traffic list holds rows only; the views that show bodies fetch the entry
// from main here, and fetch it again whenever its row changes (a pending
// exchange completing, a stream growing).
import { useEffect, useState } from 'react';
import { useProxyStore } from '../stores/proxyStore';
import type { TrafficEntry } from '../../../shared/types';

export interface TrafficEntryState {
  /**
   * The entry for `id` once fetched. While a new id loads this is still the
   * previous entry, so a pane does not flash empty between two selections;
   * compare `entry.trafficId` to `id` when that matters.
   */
  entry: TrafficEntry | undefined;
  /** True once `entry` belongs to the requested id and reflects its latest row. */
  ready: boolean;
}

export function useTrafficEntry(id: number | null | undefined): TrafficEntryState {
  // The row object is replaced on every update of that exchange, so it doubles
  // as the "refetch" signal.
  const row = useProxyStore((s) =>
    id === null || id === undefined ? undefined : s.traffic.find((e) => e.trafficId === id)
  );
  const [state, setState] = useState<{ entry: TrafficEntry | undefined; row: unknown }>({
    entry: undefined,
    row: undefined,
  });

  useEffect(() => {
    if (!row) return;
    let current = true;
    void window.reversee.getTrafficEntry(row.trafficId).then((entry) => {
      // A later selection or update has superseded this answer.
      if (current) setState({ entry: entry ?? undefined, row });
    });
    return () => {
      current = false;
    };
  }, [row]);

  // The row is gone (cleared, evicted, another tab): there is nothing to show.
  if (!row) return { entry: undefined, ready: id === null || id === undefined };
  return { entry: state.entry, ready: state.row === row && state.entry !== undefined };
}

/** One-off fetch for actions (copy as curl, mock this response). */
export function fetchTrafficEntry(id: number): Promise<TrafficEntry | null> {
  return window.reversee.getTrafficEntry(id);
}
