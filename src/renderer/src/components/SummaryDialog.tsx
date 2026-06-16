import * as Dialog from '@radix-ui/react-dialog';
import { BarChart3, X } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { useUiStore } from '../stores/uiStore';
import { summarizeTraffic } from '../../../shared/traffic-query';

function statusColor(cls: string): string {
  if (cls === 'error' || cls.startsWith('5')) return 'text-red-600';
  if (cls.startsWith('4')) return 'text-amber-600';
  if (cls.startsWith('3')) return 'text-blue-600';
  return 'text-emerald-700';
}

function Counts({ title, entries }: { title: string; entries: Array<[string, number]> }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</div>
      {entries.length === 0 ? (
        <div className="text-sm text-neutral-400">—</div>
      ) : (
        <ul className="space-y-1 text-sm">
          {entries.map(([k, v]) => (
            <li key={k} className="flex justify-between gap-3">
              <span className={title === 'Status' ? statusColor(k) : 'text-neutral-700'}>{k}</span>
              <span className="font-mono text-neutral-500">{v}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SummaryDialog(): React.JSX.Element {
  const open = useUiStore((s) => s.summaryOpen);
  const setOpen = useUiStore((s) => s.setSummaryOpen);
  const traffic = useProxyStore((s) => s.traffic);
  const select = useProxyStore((s) => s.select);
  const s = summarizeTraffic(traffic, 5);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[640px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
              <BarChart3 className="h-4 w-4 text-blue-600" aria-hidden />
              Session summary
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-1 hover:bg-neutral-100">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>

          <div className="mb-4 text-sm text-neutral-500">{s.total} requests captured</div>

          <div className="grid grid-cols-3 gap-5">
            <Counts title="Status" entries={Object.entries(s.byStatusClass).sort()} />
            <Counts title="Method" entries={Object.entries(s.byMethod).sort((a, b) => b[1] - a[1])} />
            <Counts title="Content type" entries={Object.entries(s.contentTypes).sort((a, b) => b[1] - a[1])} />
          </div>

          <div className="mt-5">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">Top hosts</div>
            <ul className="space-y-1 text-sm">
              {s.hosts.slice(0, 6).map((h) => (
                <li key={h.host} className="flex justify-between gap-3">
                  <span className="truncate text-neutral-700">{h.host}</span>
                  <span className="font-mono text-neutral-500">{h.count}</span>
                </li>
              ))}
            </ul>
          </div>

          {s.slowest.length > 0 && (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">Slowest</div>
              <ul className="space-y-1 text-sm">
                {s.slowest.map((r) => (
                  <li key={r.trafficId}>
                    <button
                      type="button"
                      onClick={() => { select(r.trafficId); setOpen(false); }}
                      className="flex w-full justify-between gap-3 text-left hover:text-blue-600"
                    >
                      <span className="truncate">
                        <span className="font-medium">{r.method}</span> {r.url}
                      </span>
                      <span className="font-mono text-neutral-500">{r.totalMs} ms</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {s.errors.length > 0 && (
            <div className="mt-5">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-red-600">
                Errors ({s.errors.length})
              </div>
              <ul className="space-y-1 text-sm">
                {s.errors.slice(0, 10).map((r) => (
                  <li key={r.trafficId}>
                    <button
                      type="button"
                      onClick={() => { select(r.trafficId); setOpen(false); }}
                      className="flex w-full justify-between gap-3 text-left hover:text-blue-600"
                    >
                      <span className="truncate">
                        <span className="font-medium">{r.method}</span> {r.url}
                      </span>
                      <span className="font-mono text-red-600">{r.error ? 'ERR' : r.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
