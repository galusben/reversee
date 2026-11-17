// Compare screen: two captured exchanges side by side — request line, status,
// headers and bodies (JSON normalized). The diff logic is in shared/compare.ts.
import { useMemo, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { ArrowLeftRight } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { useUiStore } from '../stores/uiStore';
import { MonacoDiffView } from './MonacoView';
import { Modal, secondaryButton } from './ui/Modal';
import { compareExchanges, type BodyDiff, type FieldDiff } from '../../../shared/compare';
import { formatBytes } from '../../../shared/timings';
import type { TrafficEntry } from '../../../shared/types';

export function CompareDialog(): React.JSX.Element | null {
  const ids = useUiStore((s) => s.compareIds);
  const close = useUiStore((s) => s.closeCompare);
  const traffic = useProxyStore((s) => s.traffic);
  if (!ids) return null;
  const a = traffic.find((e) => e.trafficId === ids[0]);
  const b = traffic.find((e) => e.trafficId === ids[1]);
  if (!a || !b) return null;
  return <CompareView key={`${ids[0]}-${ids[1]}`} a={a} b={b} onClose={close} />;
}

const rowTone: Record<FieldDiff['status'], string> = {
  same: '',
  changed: 'bg-amber-50',
  added: 'bg-emerald-50',
  removed: 'bg-red-50',
};

const statusLabel: Record<FieldDiff['status'], string> = {
  same: '',
  changed: 'changed',
  added: 'only B',
  removed: 'only A',
};

function FieldTable({
  label,
  fields,
  showSame,
}: {
  label: string;
  fields: FieldDiff[];
  showSame: boolean;
}): React.JSX.Element {
  const shown = showSame ? fields : fields.filter((f) => f.status !== 'same');
  const same = fields.length - fields.filter((f) => f.status !== 'same').length;
  return (
    <section className="mb-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </h3>
      {shown.length === 0 ? (
        <p className="text-xs text-neutral-400">
          {fields.length === 0 ? 'None on either side.' : `All ${same} identical.`}
        </p>
      ) : (
        <table className="w-full table-fixed border-collapse font-mono text-xs" aria-label={label}>
          <thead className="text-left text-neutral-500">
            <tr>
              <th className="w-48 px-2 py-1 font-medium">Name</th>
              <th className="px-2 py-1 font-medium">A</th>
              <th className="px-2 py-1 font-medium">B</th>
              <th className="w-16 px-2 py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => (
              <tr
                key={f.name}
                data-diff={f.status}
                className={`border-t border-neutral-100 align-top ${rowTone[f.status]}`}
              >
                <td className="break-all px-2 py-1 font-semibold">{f.name}</td>
                <td className="break-all px-2 py-1">{f.a ?? ''}</td>
                <td className="break-all px-2 py-1">{f.b ?? ''}</td>
                <td className="px-2 py-1 text-neutral-500">{statusLabel[f.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!showSame && same > 0 && shown.length > 0 && (
        <p className="mt-1 text-xs text-neutral-400">{same} identical hidden.</p>
      )}
    </section>
  );
}

function BodyPane({ diff }: { diff: BodyDiff }): React.JSX.Element {
  const side = (s: BodyDiff['a']): string =>
    s.kind === 'empty'
      ? 'empty'
      : `${s.kind}, ${formatBytes(s.bytes)}${s.truncated ? ', truncated' : ''}`;
  const kinds = [diff.a.kind, diff.b.kind];
  const language =
    kinds.includes('json') && kinds.every((k) => k === 'json' || k === 'empty')
      ? 'json'
      : 'plaintext';
  return (
    <div className="flex h-full flex-col">
      <div className="flex justify-between px-1 py-1 text-xs text-neutral-500">
        <span>A: {side(diff.a)}</span>
        <span className={diff.equal ? 'text-emerald-700' : 'font-medium text-amber-700'}>
          {diff.equal ? 'Identical' : 'Different'}
          {diff.a.kind === 'json' || diff.b.kind === 'json' ? ' (JSON, keys sorted)' : ''}
        </span>
        <span>B: {side(diff.b)}</span>
      </div>
      <div className="min-h-0 grow border border-neutral-200">
        <MonacoDiffView original={diff.a.text} modified={diff.b.text} language={language} />
      </div>
    </div>
  );
}

function sideLabel(e: TrafficEntry): string {
  return `#${e.trafficId} ${e.request.method} ${e.request.url}`;
}

const tabClass =
  'border-b-2 border-transparent px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-800 ' +
  'data-[state=active]:border-blue-600 data-[state=active]:font-medium data-[state=active]:text-neutral-900';

function CompareView({
  a,
  b,
  onClose,
}: {
  a: TrafficEntry;
  b: TrafficEntry;
  onClose: () => void;
}): React.JSX.Element {
  const open = useUiStore((s) => s.openCompare);
  const [showSame, setShowSame] = useState(false);
  const c = useMemo(() => compareExchanges(a, b), [a, b]);
  const fieldsDiffer = [...c.requestLine, c.status, ...c.requestHeaders, ...c.responseHeaders].some(
    (f) => f.status !== 'same'
  );

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Compare requests"
      width="w-[1100px]"
      description={
        <span className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <span className="rounded bg-red-50 px-1.5 py-0.5" title="A">
            A {sideLabel(a)}
          </span>
          <button
            type="button"
            className="rounded p-1 hover:bg-neutral-100"
            aria-label="Swap A and B"
            title="Swap A and B"
            onClick={() => open(b.trafficId, a.trafficId)}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
          </button>
          <span className="rounded bg-emerald-50 px-1.5 py-0.5" title="B">
            B {sideLabel(b)}
          </span>
        </span>
      }
    >
      <section className="mb-4" aria-label="Differences">
        {c.identical ? (
          <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800">
            No differences in the request line, status, headers or bodies.
          </p>
        ) : (
          <ul className="list-disc rounded border border-neutral-200 bg-neutral-50 py-2 pl-6 pr-2 text-xs">
            {c.summary.slice(0, 12).map((line) => (
              <li key={line} className="break-all font-mono">
                {line}
              </li>
            ))}
            {c.summary.length > 12 && (
              <li className="text-neutral-500">…and {c.summary.length - 12} more</li>
            )}
          </ul>
        )}
      </section>
      <Tabs.Root defaultValue="fields" className="flex h-[460px] flex-col">
        <Tabs.List className="mb-2 flex border-b border-neutral-200" aria-label="Compare sections">
          <Tabs.Trigger className={tabClass} value="fields">
            Status &amp; Headers{fieldsDiffer ? ' •' : ''}
          </Tabs.Trigger>
          <Tabs.Trigger className={tabClass} value="response-body">
            Response Body{c.responseBody.equal ? '' : ' •'}
          </Tabs.Trigger>
          <Tabs.Trigger className={tabClass} value="request-body">
            Request Body{c.requestBody.equal ? '' : ' •'}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="fields" className="min-h-0 grow overflow-auto">
          <label className="mb-2 flex items-center gap-2 text-xs text-neutral-600">
            <input
              type="checkbox"
              checked={showSame}
              onChange={(e) => setShowSame(e.target.checked)}
            />
            Show identical fields
          </label>
          <FieldTable
            label="Request line and status"
            fields={[...c.requestLine, c.status]}
            showSame={showSame}
          />
          <FieldTable label="Request headers" fields={c.requestHeaders} showSame={showSame} />
          <FieldTable label="Response headers" fields={c.responseHeaders} showSame={showSame} />
        </Tabs.Content>
        <Tabs.Content value="response-body" className="min-h-0 grow">
          <BodyPane diff={c.responseBody} />
        </Tabs.Content>
        <Tabs.Content value="request-body" className="min-h-0 grow">
          <BodyPane diff={c.requestBody} />
        </Tabs.Content>
      </Tabs.Root>
      <div className="mt-3 flex justify-end">
        <button type="button" className={secondaryButton} onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
