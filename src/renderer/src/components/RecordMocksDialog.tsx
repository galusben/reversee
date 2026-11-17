// Record and replay: turns captured responses into mock rules in one step.
// The preview runs the same shared conversion main runs when saving.
import { useMemo, useState } from 'react';
import { useProxyStore } from '../stores/proxyStore';
import { useUiStore } from '../stores/uiStore';
import { Modal, primaryButton, secondaryButton } from './ui/Modal';
import { listedTraffic } from './TrafficTable';
import { mergeRecorded, recordMocks } from '../../../shared/record-mocks';
import { describeMock } from '../../../shared/rule-input';
import type { TrafficEntry } from '../../../shared/types';

type Scope = 'all' | 'listed' | 'one';

const PREVIEW_ROWS = 8;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function RecordMocksDialog(): React.JSX.Element | null {
  const state = useUiStore((s) => s.recordMocks);
  const setOpen = useUiStore((s) => s.setRecordMocks);
  // Mounted only while open, so its choices start fresh each time.
  return state ? (
    <RecordMocksBody trafficId={state.trafficId} onClose={() => setOpen(false)} />
  ) : null;
}

function RecordMocksBody({
  trafficId,
  onClose,
}: {
  trafficId?: number;
  onClose: () => void;
}): React.JSX.Element {
  const all = useProxyStore((s) => s.traffic);
  const filterText = useProxyStore((s) => s.filterText);
  const errorsOnly = useProxyStore((s) => s.errorsOnly);
  const savedMocks = useProxyStore((s) => s.settings?.mocks ?? []);
  const running = useProxyStore((s) => s.running);
  const showNotice = useUiStore((s) => s.showNotice);

  const listed = useMemo(
    () => listedTraffic(all, filterText, errorsOnly),
    [all, filterText, errorsOnly]
  );
  const single = all.find((e) => e.trafficId === trafficId);
  const filtered = listed.length !== all.length;
  const [scope, setScope] = useState<Scope>(single ? 'one' : filtered ? 'listed' : 'all');
  const [ignoreQuery, setIgnoreQuery] = useState(false);
  const [busy, setBusy] = useState(false);

  const chosen: TrafficEntry[] = useMemo(
    () => (scope === 'one' && single ? [single] : scope === 'listed' ? listed : all),
    [scope, single, listed, all]
  );
  const preview = useMemo(() => {
    const recording = recordMocks(chosen, { ignoreQuery });
    return { recording, merge: mergeRecorded(savedMocks, recording) };
  }, [chosen, ignoreQuery, savedMocks]);
  const { recording, merge } = preview;
  const total = merge.added + merge.replaced;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.reversee.recordMocks(
        scope === 'all' ? undefined : chosen.map((e) => e.trafficId),
        { ignoreQuery }
      );
      const parts = [plural(result.created, 'new mock')];
      if (result.replaced) parts.push(`${result.replaced} updated`);
      const skipped = result.skipped.reduce((n, s) => n + s.count, 0);
      if (skipped) parts.push(`${skipped} skipped`);
      showNotice({
        kind: 'info',
        text: `Recorded ${parts.join(', ')}. Switch them off in Routes and mocks.`,
      });
      onClose();
    } catch (error) {
      showNotice({ kind: 'error', text: `Recording failed: ${(error as Error).message}` });
      setBusy(false);
    }
  };

  const option = (value: Scope, label: string): React.JSX.Element => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name="record-scope"
        checked={scope === value}
        onChange={() => setScope(value)}
      />
      {label}
    </label>
  );

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Record as mocks"
      width="w-[640px]"
      description="Save captured responses as mocks, so the proxy answers these requests by itself: run a frontend offline, or a test against fixed responses."
    >
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Requests to record
        </legend>
        {option('all', `All captured requests (${all.length})`)}
        {filtered && option('listed', `The ${listed.length} requests the filter lists`)}
        {single &&
          option(
            'one',
            `Only #${single.trafficId}: ${single.request.method} ${single.request.url}`
          )}
      </fieldset>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={ignoreQuery}
          onChange={(e) => setIgnoreQuery(e.target.checked)}
        />
        Match any query string (otherwise /search?q=a and /search?q=b are separate mocks)
      </label>

      <div className="mt-4 rounded-md border border-neutral-200 p-3" aria-label="Recording preview">
        <p className="text-sm font-medium">
          {total === 0
            ? 'Nothing to record.'
            : `${plural(merge.added, 'new mock')}${merge.replaced ? `, ${merge.replaced} updated` : ''}`}
        </p>
        {merge.stored.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 font-mono text-xs text-neutral-600">
            {merge.stored.slice(0, PREVIEW_ROWS).map(({ rule, trafficId: id }) => (
              <li key={rule.id} className="truncate">
                #{id} → {describeMock(rule)}
              </li>
            ))}
            {merge.stored.length > PREVIEW_ROWS && (
              <li>…and {merge.stored.length - PREVIEW_ROWS} more</li>
            )}
          </ul>
        )}
        {(recording.skipped.length > 0 || merge.overLimit > 0) && (
          <ul className="mt-2 space-y-0.5 text-xs text-amber-700">
            {recording.skipped.map((s) => (
              <li key={s.reason}>
                Skipped {s.count}: {s.reason}
              </li>
            ))}
            {merge.overLimit > 0 && (
              <li>Skipped {merge.overLimit}: the mock list is full (200 rules)</li>
            )}
          </ul>
        )}
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        Each method and URL becomes one mock; the latest response wins. Saved mocks for the same
        request are updated, new ones go after your other mocks.{' '}
        {running ? 'They answer at once.' : 'They answer once the proxy starts.'}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButton}
          disabled={total === 0 || busy}
          onClick={() => void save()}
        >
          {total === 0 ? 'Record' : `Record ${plural(total, 'mock')}`}
        </button>
      </div>
    </Modal>
  );
}
