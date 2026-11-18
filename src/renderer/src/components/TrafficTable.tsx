import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Clapperboard,
  Download,
  Lock,
  LockOpen,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { useProxyStore, type SortKey, type SortState } from '../stores/proxyStore';
import { useUiStore } from '../stores/uiStore';
import { WithContextMenu } from './ui/ContextMenu';
import { mockFromEntry, routeFromEntry } from '../lib/rule-seed';
import { fetchTrafficEntry } from '../lib/use-traffic-entry';
import { filterTraffic, hostOf } from '../../../shared/traffic-query';
import { formatBytes, formatDuration, totalMs } from '../../../shared/timings';
import type { TrafficRow } from '../../../shared/traffic-row';

/** Must match .traffic-row in styles.css: the table renders only the visible rows. */
export const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 33;
const OVERSCAN = 12;
/** Used until the container has been measured (and in jsdom, which never measures). */
const FALLBACK_VIEWPORT = 800;

function statusClass(entry: TrafficRow): string {
  if (entry.pending) return 'text-neutral-400';
  // For gRPC the HTTP status is 200 even on failure; the grpc-status trailer
  // carries the real outcome (0 = OK).
  if (entry.grpc?.status !== undefined) {
    return entry.grpc.status === 0 ? 'text-emerald-700' : 'text-red-600';
  }
  const code = entry.response.statusCode ?? 0;
  if (entry.connectorError || code >= 500) return 'text-red-600';
  if (code >= 400) return 'text-amber-600';
  if (code >= 300) return 'text-blue-600';
  return 'text-emerald-700';
}

/** Status cell text: gRPC status code when present, else the HTTP status. */
function statusText(entry: TrafficRow): string {
  if (entry.connectorError) return 'ERR';
  if (entry.grpc?.status !== undefined) return `gRPC ${entry.grpc.status}`;
  if (entry.response.statusCode === undefined) return entry.pending ? '…' : '';
  return String(entry.response.statusCode);
}

/** Host cell: the server the request went to, with the port when it is not the usual one. */
function hostLabel(entry: TrafficRow): string {
  const target = entry.request.target;
  if (!target) {
    const host = hostOf(entry);
    return host === '(unknown)' ? '' : host;
  }
  const usual = target.protocol === 'https' ? 443 : 80;
  return target.port === usual ? target.host : `${target.host}:${target.port}`;
}

function contentType(entry: TrafficRow): string {
  const value = entry.response.headers['content-type'];
  const text = Array.isArray(value) ? value[0] : value;
  return text ? text.split(';')[0] : '';
}

/** Rows carry the size (toTrafficRow fills it in from the body when the core did not). */
function responseSize(entry: TrafficRow): number | undefined {
  return entry.response.size;
}

function startedAt(entry: TrafficRow): string {
  const date = new Date(entry.timings.start);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour12: false });
}

function sortValue(entry: TrafficRow, key: SortKey): number | string {
  switch (key) {
    case 'id':
      return entry.trafficId;
    case 'method':
      return entry.grpc ? 'GRPC' : entry.request.method;
    case 'host':
      return hostLabel(entry);
    case 'url':
      return entry.request.url;
    case 'status':
      return entry.connectorError ? 999 : (entry.response.statusCode ?? 0);
    case 'type':
      return contentType(entry);
    case 'size':
      return responseSize(entry) ?? -1;
    case 'duration':
      return totalMs(entry.timings) ?? -1;
  }
}

/** The entries the table lists under the current filter (unsorted). */
export function listedTraffic(
  all: TrafficRow[],
  filterText: string,
  errorsOnly: boolean
): TrafficRow[] {
  if (!filterText && !errorsOnly) return all;
  return filterTraffic(all, {
    ...(filterText ? { text: filterText } : {}),
    ...(errorsOnly ? { hasError: true } : {}),
  });
}

function sortTraffic(entries: TrafficRow[], sort: SortState): TrafficRow[] {
  // The store is already in id order: the default view needs no work.
  if (sort.key === 'id') return sort.dir === 'asc' ? entries : [...entries].reverse();
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    const cmp =
      typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return cmp !== 0 ? cmp * sign : a.trafficId - b.trafficId;
  });
}

function Badge({ children, tone }: { children: string; tone: string }): React.JSX.Element {
  return (
    <span className={`mr-1.5 rounded px-1.5 py-0.5 text-xs font-semibold ${tone}`}>{children}</span>
  );
}

// Memoized: with thousands of entries a naive table re-renders every visible
// row for each incoming request.
const Row = memo(function Row({
  entry,
  selected,
  marked,
  onSelect,
  onMenu,
}: {
  entry: TrafficRow;
  selected: boolean;
  /** Marked as side A of a comparison. */
  marked: boolean;
  onSelect: (id: number) => void;
  onMenu: (entry: TrafficRow) => void;
}): React.JSX.Element {
  return (
    <tr
      onClick={() => onSelect(entry.trafficId)}
      onContextMenu={() => onMenu(entry)}
      aria-selected={selected}
      data-traffic-id={entry.trafficId}
      className={`traffic-row cursor-pointer border-b border-neutral-100 hover:bg-neutral-50 ${
        selected ? 'bg-blue-50 font-semibold' : ''
      } ${entry.pending ? 'italic text-neutral-500' : ''}`}
    >
      {/* The stable trafficId — the same handle MCP tools (get_traffic_entry,
          replay_request) reference. */}
      <td className="px-3 text-neutral-400" title="Request id">
        {entry.trafficId}
        {entry.replay ? ' ↺' : ''}
      </td>
      <td className="px-3 font-medium">
        {entry.grpc ? (
          <Badge tone="bg-indigo-100 text-indigo-700">gRPC</Badge>
        ) : (
          entry.request.method
        )}
      </td>
      <td className="max-w-0 truncate px-3 text-neutral-600" title={hostLabel(entry)}>
        {hostLabel(entry)}
      </td>
      <td className="max-w-0 px-3" title={entry.request.url}>
        {marked && (
          <span title="Marked for compare (A)">
            <Badge tone="bg-fuchsia-100 text-fuchsia-700">A</Badge>
          </span>
        )}
        {entry.ws && <Badge tone="bg-emerald-100 text-emerald-700">WS</Badge>}
        {entry.mocked && <Badge tone="bg-amber-100 text-amber-800">MOCK</Badge>}
        {entry.imported && <Badge tone="bg-neutral-200 text-neutral-600">HAR</Badge>}
        {entry.request.url}
      </td>
      <td className={`px-3 font-medium ${statusClass(entry)}`}>{statusText(entry)}</td>
      <td className="px-3 text-neutral-500">{contentType(entry)}</td>
      <td className="px-3 text-right tabular-nums text-neutral-500">
        {formatBytes(responseSize(entry))}
      </td>
      <td className="px-3 text-right tabular-nums text-neutral-500">
        {entry.pending ? '' : formatDuration(totalMs(entry.timings))}
      </td>
      <td className="px-3 text-right tabular-nums text-neutral-400">{startedAt(entry)}</td>
    </tr>
  );
});

const COLUMNS: Array<{ key: SortKey | null; label: string; className: string }> = [
  { key: 'id', label: '#', className: 'w-16' },
  { key: 'method', label: 'Method', className: 'w-20' },
  { key: 'host', label: 'Host', className: 'w-48' },
  { key: 'url', label: 'Path', className: '' },
  { key: 'status', label: 'Status', className: 'w-20' },
  { key: 'type', label: 'Content-Type', className: 'w-44' },
  { key: 'size', label: 'Size', className: 'w-20 text-right' },
  { key: 'duration', label: 'Time', className: 'w-20 text-right' },
  { key: null, label: 'Started', className: 'w-24 text-right' },
];

export function TrafficTable(): React.JSX.Element {
  const allTraffic = useProxyStore((s) => s.traffic);
  const selectedId = useProxyStore((s) => s.selectedId);
  const select = useProxyStore((s) => s.select);
  const clearTraffic = useProxyStore((s) => s.clearTraffic);
  const filterText = useProxyStore((s) => s.filterText);
  const setFilterText = useProxyStore((s) => s.setFilterText);
  const errorsOnly = useProxyStore((s) => s.errorsOnly);
  const toggleErrorsOnly = useProxyStore((s) => s.toggleErrorsOnly);
  const sort = useProxyStore((s) => s.sort);
  const sortBy = useProxyStore((s) => s.sortBy);
  const replay = useProxyStore((s) => s.replay);
  const exportHar = useProxyStore((s) => s.exportHar);
  const importHar = useProxyStore((s) => s.importHar);
  const scrollLocked = useProxyStore((s) => s.scrollLocked);
  const toggleScrollLock = useProxyStore((s) => s.toggleScrollLock);
  const openSummary = useUiStore((s) => s.setSummaryOpen);
  const openReplayEditor = useUiStore((s) => s.setReplayEditorId);
  const openRules = useUiStore((s) => s.setRulesOpen);
  const openRecordMocks = useUiStore((s) => s.setRecordMocks);
  const filterFocusRequest = useUiStore((s) => s.filterFocusRequest);
  const compareBaseId = useUiStore((s) => s.compareBaseId);
  const setCompareBaseId = useUiStore((s) => s.setCompareBaseId);
  const openCompare = useUiStore((s) => s.openCompare);
  const showNotice = useUiStore((s) => s.showNotice);

  const traffic = useMemo(
    () => sortTraffic(listedTraffic(allTraffic, filterText, errorsOnly), sort),
    [allTraffic, filterText, errorsOnly, sort]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  // One context menu for the whole table (a Radix menu root per row is far
  // too heavy); the right-clicked entry is tracked here.
  const menuEntryRef = useRef<TrafficRow | null>(null);
  // Stable identity, or every memoized row would re-render on each update.
  const onMenu = useCallback((entry: TrafficRow) => {
    menuEntryRef.current = entry;
  }, []);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (): void => setViewport(el.clientHeight || FALLBACK_VIEWPORT);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Follow new traffic — only meaningful when the newest row is at the bottom.
  const followsTail = !scrollLocked && sort.key === 'id' && sort.dir === 'asc';
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (followsTail && el) el.scrollTop = el.scrollHeight;
  }, [traffic, followsTail]);

  useEffect(() => {
    if (filterFocusRequest > 0) {
      filterRef.current?.focus();
      filterRef.current?.select();
    }
  }, [filterFocusRequest]);

  // Only the rows in (or near) view are in the DOM; spacer rows keep the
  // scrollbar honest.
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(traffic.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const visible = traffic.slice(first, last);
  const padTop = first * ROW_HEIGHT;
  const padBottom = (traffic.length - last) * ROW_HEIGHT;

  const selectAt = (index: number): void => {
    const entry = traffic[Math.max(0, Math.min(traffic.length - 1, index))];
    if (!entry) return;
    select(entry.trafficId);
    const el = containerRef.current;
    if (!el) return;
    const i = traffic.indexOf(entry);
    const top = i * ROW_HEIGHT;
    const height = el.clientHeight || viewport;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + height - HEADER_HEIGHT) {
      el.scrollTop = top + ROW_HEIGHT - height + HEADER_HEIGHT;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (traffic.length === 0) return;
    const current = traffic.findIndex((t) => t.trafficId === selectedId);
    const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1);
    const moves: Record<string, number> = {
      ArrowDown: current + 1,
      ArrowUp: current < 0 ? traffic.length - 1 : current - 1,
      PageDown: current + page,
      PageUp: current - page,
      Home: 0,
      End: traffic.length - 1,
    };
    if (!(e.key in moves) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    selectAt(moves[e.key]);
  };

  const toolButton = 'rounded p-1 text-neutral-500 hover:bg-neutral-100';

  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-white px-3 py-1.5">
        <div className="relative grow">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400"
            aria-hidden
          />
          <input
            ref={filterRef}
            type="text"
            aria-label="Filter traffic"
            placeholder="Filter — method, host, path, status, content-type…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFilterText('');
                containerRef.current?.focus();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                containerRef.current?.focus();
                selectAt(0);
              }
            }}
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
            errorsOnly
              ? 'border-red-300 bg-red-50 text-red-700'
              : 'border-neutral-300 text-neutral-600 hover:bg-neutral-50'
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
          onClick={() =>
            void exportHar(
              traffic.length === allTraffic.length ? undefined : traffic.map((t) => t.trafficId)
            )
          }
          title="Export the listed requests as a HAR file"
          aria-label="Export HAR"
          className={toolButton}
        >
          <Download className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => void importHar()}
          title="Import a HAR file"
          aria-label="Import HAR"
          className={toolButton}
        >
          <Upload className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => openRecordMocks(true)}
          disabled={allTraffic.length === 0}
          title="Record as mocks: serve these responses again without the upstream"
          aria-label="Record as mocks"
          className={`${toolButton} disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          <Clapperboard className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => openSummary(true)}
          title="Session summary"
          aria-label="Session summary"
          className={toolButton}
        >
          <BarChart3 className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={toggleScrollLock}
          title={scrollLocked ? 'Auto-scroll is off' : 'Auto-scroll is on'}
          aria-label={scrollLocked ? 'Enable auto-scroll' : 'Disable auto-scroll'}
          className={toolButton}
        >
          {scrollLocked ? (
            <Lock className="h-4 w-4" aria-hidden />
          ) : (
            <LockOpen className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>
      <div
        ref={containerRef}
        tabIndex={0}
        role="region"
        aria-label="Captured traffic"
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="min-h-0 grow overflow-auto bg-white focus:outline-none"
      >
        <table className="w-full table-fixed border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              {COLUMNS.map((col) => {
                const active = col.key !== null && sort.key === col.key;
                return (
                  <th
                    key={col.label}
                    className={`px-3 py-2 ${col.className}`}
                    aria-sort={
                      active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                  >
                    {col.key === null ? (
                      col.label
                    ) : (
                      <button
                        type="button"
                        onClick={() => sortBy(col.key as SortKey)}
                        title={`Sort by ${col.label === '#' ? 'request id' : col.label}`}
                        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-neutral-800"
                      >
                        {col.label}
                        {active &&
                          (sort.dir === 'asc' ? (
                            <ArrowUp className="h-3 w-3" aria-hidden />
                          ) : (
                            <ArrowDown className="h-3 w-3" aria-hidden />
                          ))}
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <WithContextMenu
            items={[
              {
                label: 'Replay',
                onSelect: () => {
                  if (menuEntryRef.current) void replay(menuEntryRef.current.trafficId);
                },
              },
              {
                label: 'Edit and Replay…',
                onSelect: () => openReplayEditor(menuEntryRef.current?.trafficId ?? null),
              },
              ...(compareBaseId !== null
                ? [
                    {
                      label: `Compare with #${compareBaseId}`,
                      onSelect: () => {
                        const entry = menuEntryRef.current;
                        if (!entry) return;
                        if (entry.trafficId === compareBaseId) {
                          showNotice({
                            kind: 'info',
                            text: `#${compareBaseId} is marked — right-click a different request to compare.`,
                          });
                        } else {
                          openCompare(compareBaseId, entry.trafficId);
                        }
                      },
                    },
                    { label: 'Clear Compare Mark', onSelect: () => setCompareBaseId(null) },
                  ]
                : [
                    {
                      label: 'Mark for Compare',
                      onSelect: () => {
                        const entry = menuEntryRef.current;
                        if (!entry) return;
                        setCompareBaseId(entry.trafficId);
                        showNotice({
                          kind: 'info',
                          text: `Marked #${entry.trafficId} as A — right-click another request and choose Compare with #${entry.trafficId}.`,
                        });
                      },
                    },
                  ]),
              {
                label: 'Mock This Response…',
                onSelect: () => {
                  const row = menuEntryRef.current;
                  if (!row) return;
                  // The mock is seeded with the response body, fetched from main.
                  void fetchTrafficEntry(row.trafficId).then((entry) => {
                    if (entry) openRules(true, { kind: 'mock', rule: mockFromEntry(entry) });
                  });
                },
              },
              {
                label: 'Record as Mocks…',
                onSelect: () => openRecordMocks(true, menuEntryRef.current?.trafficId),
              },
              {
                label: 'Route Requests Like This…',
                onSelect: () => {
                  const entry = menuEntryRef.current;
                  if (entry) openRules(true, { kind: 'route', rule: routeFromEntry(entry) });
                },
              },
              {
                label: 'Copy as curl',
                onSelect: () => {
                  const row = menuEntryRef.current;
                  if (!row) return;
                  void fetchTrafficEntry(row.trafficId).then((entry) =>
                    window.reversee.copyToClipboard(entry?.request.curl ?? '')
                  );
                },
              },
              {
                label: 'Copy URL',
                onSelect: () =>
                  void window.reversee.copyToClipboard(menuEntryRef.current?.request.url ?? ''),
              },
              {
                label: 'Export as HAR…',
                onSelect: () => {
                  if (menuEntryRef.current) void exportHar([menuEntryRef.current.trafficId]);
                },
              },
              { label: 'Clear All', onSelect: () => void clearTraffic() },
            ]}
          >
            <tbody>
              {padTop > 0 && (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={COLUMNS.length} />
                </tr>
              )}
              {visible.map((entry) => (
                <Row
                  key={entry.trafficId}
                  entry={entry}
                  selected={selectedId === entry.trafficId}
                  marked={compareBaseId === entry.trafficId}
                  onSelect={select}
                  onMenu={onMenu}
                />
              ))}
              {padBottom > 0 && (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={COLUMNS.length} />
                </tr>
              )}
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
