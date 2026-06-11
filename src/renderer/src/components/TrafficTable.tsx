import { useEffect, useRef } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { WithContextMenu } from './ui/ContextMenu';
import type { TrafficEntry } from '../../../shared/types';

function statusClass(entry: TrafficEntry): string {
  const code = entry.response.statusCode ?? 0;
  if (code >= 500) return 'text-red-600';
  if (code >= 400) return 'text-amber-600';
  if (code >= 300) return 'text-blue-600';
  return 'text-emerald-700';
}

function contentType(entry: TrafficEntry): string {
  const value = entry.response.headers['content-type'];
  const text = Array.isArray(value) ? value[0] : value;
  return text ? text.split(';')[0] : '';
}

function Row({
  entry,
  index,
  selected,
  onClick,
}: {
  entry: TrafficEntry;
  index: number;
  selected: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const clearTraffic = useProxyStore((s) => s.clearTraffic);
  return (
    <WithContextMenu
      items={[
        {
          label: 'Copy as curl',
          onSelect: () => void window.reversee.copyToClipboard(entry.request.curl ?? ''),
        },
        { label: 'Clear All', onSelect: () => void clearTraffic() },
      ]}
    >
      <tr
        onClick={onClick}
        aria-selected={selected}
        className={`cursor-pointer border-b border-neutral-100 hover:bg-neutral-50 ${
          selected ? 'bg-blue-50 font-semibold' : ''
        }`}
      >
        <td className="px-3 py-1.5 text-neutral-400">{index + 1}</td>
        <td className="px-3 py-1.5 font-medium">{entry.request.method}</td>
        <td className="max-w-0 truncate px-3 py-1.5" title={entry.request.url}>
          {entry.request.url}
        </td>
        <td className={`px-3 py-1.5 font-medium ${statusClass(entry)}`}>
          {entry.connectorError ? 'ERR' : (entry.response.statusCode ?? '')}
        </td>
        <td className="truncate px-3 py-1.5 text-neutral-500">{contentType(entry)}</td>
      </tr>
    </WithContextMenu>
  );
}

export function TrafficTable(): React.JSX.Element {
  const traffic = useProxyStore((s) => s.traffic);
  const selectedId = useProxyStore((s) => s.selectedId);
  const select = useProxyStore((s) => s.select);
  const scrollLocked = useProxyStore((s) => s.scrollLocked);
  const toggleScrollLock = useProxyStore((s) => s.toggleScrollLock);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollLocked && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [traffic, scrollLocked]);

  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex items-center justify-end gap-2 border-b border-neutral-200 bg-white px-3 py-1">
        <button
          type="button"
          onClick={toggleScrollLock}
          title={scrollLocked ? 'Auto-scroll is off' : 'Auto-scroll is on'}
          aria-label={scrollLocked ? 'Enable auto-scroll' : 'Disable auto-scroll'}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-100"
        >
          {scrollLocked ? (
            <Lock className="h-4 w-4" aria-hidden />
          ) : (
            <LockOpen className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
      <div ref={containerRef} className="min-h-0 grow overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="w-12 px-3 py-2">#</th>
              <th className="w-20 px-3 py-2">Method</th>
              <th className="px-3 py-2">Path</th>
              <th className="w-20 px-3 py-2">Status</th>
              <th className="w-48 px-3 py-2">Content-Type</th>
            </tr>
          </thead>
          <tbody>
            {traffic.map((entry, index) => (
              <Row
                key={entry.trafficId}
                entry={entry}
                index={index}
                selected={selectedId === entry.trafficId}
                onClick={() => select(entry.trafficId)}
              />
            ))}
          </tbody>
        </table>
        {traffic.length === 0 && (
          <div className="p-8 text-center text-sm text-neutral-400">
            No traffic yet. Start the proxy and send requests to the listen port.
          </div>
        )}
      </div>
    </div>
  );
}
