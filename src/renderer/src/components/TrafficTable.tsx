import { memo, useEffect, useRef } from 'react';
import { BarChart3, Lock, LockOpen, Search, X } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { useUiStore } from '../stores/uiStore';
import { WithContextMenu } from './ui/ContextMenu';
import { filterTraffic } from '../../../shared/traffic-query';
import type { TrafficEntry } from '../../../shared/types';

function statusClass(entry: TrafficEntry): string {
  // For gRPC the HTTP status is 200 even on failure; the grpc-status trailer
  // carries the real outcome (0 = OK).
  if (entry.grpc?.status !== undefined) {
    return entry.grpc.status === 0 ? 'text-emerald-700' : 'text-red-600';
  }
  const code = entry.response.statusCode ?? 0;
  if (code >= 500) return 'text-red-600';
  if (code >= 400) return 'text-amber-600';
  if (code >= 300) return 'text-blue-600';
  return 'text-emerald-700';
}

/** Status cell text: gRPC status code when present, else the HTTP status. */
function statusText(entry: TrafficEntry): string {
  if (entry.connectorError) return 'ERR';
  if (entry.grpc?.status !== undefined) return `gRPC ${entry.grpc.status}`;
  return String(entry.response.statusCode ?? '');
}

function contentType(entry: TrafficEntry): string {
  const value = entry.response.headers['content-type'];
  const text = Array.isArray(value) ? value[0] : value;
  return text ? text.split(';')[0] : '';
}

// Memoized: at the 1,000-entry cap a naive table re-renders every row for
// each incoming request.
const Row = memo(function Row({
  entry,
  selected,
  onClick,
  onContextMenu,
}: {
  entry: TrafficEntry;
  selected: boolean;
  onClick: () => void;
  onContextMenu: () => void;
}): React.JSX.Element {
  return (
    <tr
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-selected={selected}
      className={`cursor-pointer border-b border-neutral-100 hover:bg-neutral-50 ${
        selected ? 'bg-blue-50 font-semibold' : ''
      }`}
    >
      {/* The stable trafficId — the same handle MCP tools (get_traffic_entry,
          replay_request) reference. */}
      <td className="px-3 py-1.5 text-neutral-400" title="Request id">
        {entry.trafficId}
        {entry.replay ? ' ↺' : ''}
      </td>
      <td className="px-3 py-1.5 font-medium">
        {entry.grpc ? (
          <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-xs font-semibold text-indigo-700">
            gRPC
          </span>
        ) : (
          entry.request.method
        )}
      </td>
      <td className="max-w-0 truncate px-3 py-1.5" title={entry.request.url}>
        {entry.request.url}
      </td>
      <td className={`px-3 py-1.5 font-medium ${statusClass(entry)}`}>{statusText(entry)}</td>
      <td className="truncate px-3 py-1.5 text-neutral-500">{contentType(entry)}</td>
    </tr>
  );
});

export function TrafficTable(): React.JSX.Element {
  const allTraffic = useProxyStore((s) => s.traffic);
  const selectedId = useProxyStore((s) => s.selectedId);
  const select = useProxyStore((s) => s.select);
  const clearTraffic = useProxyStore((s) => s.clearTraffic);
  const filterText = useProxyStore((s) => s.filterText);
  const setFilterText = useProxyStore((s) => s.setFilterText);
  const errorsOnly = useProxyStore((s) => s.errorsOnly);
  const toggleErrorsOnly = useProxyStore((s) => s.toggleErrorsOnly);
  const openSummary = useUiStore((s) => s.setSummaryOpen);
  const scrollLocked = useProxyStore((s) => s.scrollLocked);

  const filtered =
    filterText || errorsOnly
      ? filterTraffic(allTraffic, {
          ...(filterText ? { text: filterText } : {}),
          ...(errorsOnly ? { hasError: true } : {}),
        })
      : allTraffic;
  const traffic = filtered;
  const toggleScrollLock = useProxyStore((s) => s.toggleScrollLock);
  const containerRef = useRef<HTMLDivElement>(null);
  // One context menu for the whole table (a Radix menu root per row is far
  // too heavy at the traffic cap); the right-clicked entry is tracked here.
  const menuEntryRef = useRef<TrafficEntry | null>(null);

  useEffect(() => {
    if (!scrollLocked && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [traffic, scrollLocked]);

  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-white px-3 py-1.5">
        <div className="relative grow">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" aria-hidden />
          <input
            type="text"
            aria-label="Filter traffic"
            placeholder="Filter — method, path, status, content-type…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="w-full rounded-md border border-neutral-300 py-1 pl-7 pr-7 text-sm focus:border-blue-400 focus:outline-none"
          />
          {filterText && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setFilterText('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-400 hover:bg-neutral-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={toggleErrorsOnly}
          aria-pressed={errorsOnly}
          title="Show only failures (status ≥ 400 or connection errors)"
          className={`rounded-md border px-2 py-1 text-xs font-medium ${
            errorsOnly ? 'border-red-300 bg-red-50 text-red-700' : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'
          }`}
        >
          Errors
        </button>
        {(filterText || errorsOnly) && (
          <span className="text-xs text-neutral-500">
            {traffic.length} of {allTraffic.length}
          </span>
        )}
        <button
          type="button"
          onClick={() => openSummary(true)}
          title="Session summary"
          aria-label="Session summary"
          className="rounded p-1 text-neutral-500 hover:bg-neutral-100"
        >
          <BarChart3 className="h-4 w-4" aria-hidden />
        </button>
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
          <WithContextMenu
            items={[
              {
                label: 'Copy as curl',
                onSelect: () =>
                  void window.reversee.copyToClipboard(menuEntryRef.current?.request.curl ?? ''),
              },
              { label: 'Clear All', onSelect: () => void clearTraffic() },
            ]}
          >
            <tbody>
              {traffic.map((entry) => (
                <Row
                  key={entry.trafficId}
                  entry={entry}
                  selected={selectedId === entry.trafficId}
                  onClick={() => select(entry.trafficId)}
                  onContextMenu={() => {
                    menuEntryRef.current = entry;
                  }}
                />
              ))}
            </tbody>
          </WithContextMenu>
        </table>
        {traffic.length === 0 && (
          <div className="p-8 text-center text-sm text-neutral-400">
            {allTraffic.length === 0
              ? 'No traffic yet. Start the proxy and send requests to the listen port.'
              : 'No requests match the filter.'}
          </div>
        )}
      </div>
    </div>
  );
}
