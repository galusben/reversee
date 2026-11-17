// The tab strip: one tab per proxy session, so several tools can be debugged
// side by side. Each tab shows whether its proxy runs, its port, new traffic
// and — most important — requests held at a breakpoint, which block a real
// client even while the tab is in the background.
import { useEffect, useRef, useState } from 'react';
import { OctagonPause, Plus, X } from 'lucide-react';
import { WithContextMenu, type ContextMenuItem } from './ui/ContextMenu';
import { useTabsStore } from '../stores/tabsStore';
import { useUiStore } from '../stores/uiStore';
import type { TabSummary } from '../../../shared/tabs';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

function tabTooltip(tab: TabSummary): string {
  const target = tab.captureAll
    ? 'any server (capture anything)'
    : (tab.destination ?? 'no destination yet');
  const state = tab.error
    ? `failed: ${tab.error}`
    : tab.running
      ? `running on port ${tab.port ?? tab.listenPort}`
      : 'stopped';
  return `${tab.name} · ${tab.id}\n:${tab.listenPort} → ${target}\n${state}`;
}

function StatusDot({ tab }: { tab: TabSummary }): React.JSX.Element {
  const color = tab.error
    ? 'bg-red-500'
    : tab.running
      ? 'bg-emerald-500'
      : 'border border-neutral-400 bg-transparent';
  return (
    <span
      aria-hidden
      data-testid={`tab-status-${tab.id}`}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`}
    />
  );
}

function RenameInput({ tab, onDone }: { tab: TabSummary; onDone: () => void }): React.JSX.Element {
  const rename = useTabsStore((s) => s.rename);
  const [value, setValue] = useState(tab.nameIsCustom ? tab.name : '');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  // Enter, Escape and blur can all end an edit; only the first one counts.
  const finished = useRef(false);
  const finish = (): void => {
    finished.current = true;
    onDone();
  };
  const commit = async (fromBlur = false): Promise<void> => {
    if (finished.current) return;
    const result = await rename(tab.id, value);
    if (result.ok) finish();
    else if (fromBlur) {
      // Clicking away keeps the old name rather than trapping focus in the field.
      useUiStore.getState().showNotice({ kind: 'error', text: result.error });
      finish();
    } else setError(result.error);
  };

  return (
    <input
      ref={ref}
      aria-label="Tab name"
      aria-invalid={Boolean(error)}
      title={
        error ?? 'Enter to save, Esc to cancel. Leave empty to name the tab after its destination.'
      }
      placeholder={tab.name}
      value={value}
      maxLength={60}
      onChange={(e) => {
        setValue(e.target.value);
        setError(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') void commit();
        if (e.key === 'Escape') finish();
      }}
      onBlur={() => void commit(true)}
      onClick={(e) => e.stopPropagation()}
      className={`w-36 rounded border bg-white px-1 py-0 text-xs ${
        error ? 'border-red-500 bg-red-50' : 'border-blue-400'
      }`}
    />
  );
}

function Tab({
  tab,
  index,
  active,
  unread,
  renaming,
  onRename,
  onRenameDone,
}: {
  tab: TabSummary;
  index: number;
  active: boolean;
  unread: boolean;
  renaming: boolean;
  onRename: () => void;
  onRenameDone: () => void;
}): React.JSX.Element {
  const { select, close, create, move, tabs } = useTabsStore.getState();
  const [dropTarget, setDropTarget] = useState(false);

  const items: ContextMenuItem[] = [
    { label: 'Rename…', onSelect: onRename },
    { label: 'Duplicate', onSelect: () => void create(tab.id) },
    { label: 'Close', onSelect: () => void close(tab.id) },
    ...(tabs.length > 1
      ? [
          {
            label: 'Close Other Tabs',
            onSelect: () => {
              void (async () => {
                for (const other of useTabsStore.getState().tabs) {
                  if (other.id !== tab.id) await close(other.id);
                }
              })();
            },
          },
        ]
      : []),
  ];

  return (
    <WithContextMenu items={items}>
      <div
        role="tab"
        id={`tab-${tab.id}`}
        aria-selected={active}
        aria-label={`${tab.name}${tab.running ? ', running' : ', stopped'}${
          tab.heldCount ? `, ${tab.heldCount} held at a breakpoint` : ''
        }`}
        tabIndex={active ? 0 : -1}
        title={tabTooltip(tab)}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-reversee-tab', tab.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-reversee-tab')) return;
          e.preventDefault();
          setDropTarget(true);
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(e) => {
          setDropTarget(false);
          const id = e.dataTransfer.getData('application/x-reversee-tab');
          if (id && id !== tab.id) void move(id, index);
        }}
        onClick={() => void select(tab.id)}
        onDoubleClick={onRename}
        onAuxClick={(e) => {
          // Middle click closes, as in browsers.
          if (e.button === 1) void close(tab.id);
        }}
        className={`group flex h-8 max-w-64 min-w-28 shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs select-none ${
          active
            ? 'border-neutral-300 bg-white text-neutral-800'
            : 'border-transparent text-neutral-500 hover:bg-neutral-50'
        } ${dropTarget ? 'ring-2 ring-blue-400' : ''}`}
      >
        {tab.heldCount > 0 ? (
          <span
            className="flex shrink-0 animate-pulse items-center gap-0.5 rounded bg-amber-100 px-1 font-medium text-amber-800"
            title={`${tab.heldCount} request${tab.heldCount === 1 ? '' : 's'} held at a breakpoint`}
          >
            <OctagonPause className="h-3 w-3" aria-hidden />
            {tab.heldCount}
          </span>
        ) : (
          <StatusDot tab={tab} />
        )}
        {renaming ? (
          <RenameInput tab={tab} onDone={onRenameDone} />
        ) : (
          <span className={`truncate ${active ? 'font-medium' : ''}`}>{tab.name}</span>
        )}
        <span className="shrink-0 text-neutral-400">:{tab.port ?? tab.listenPort}</span>
        {tab.trafficCount > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 text-neutral-400"
            aria-label={`${tab.trafficCount} requests${unread ? ', new traffic' : ''}`}
          >
            {unread && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden />}
            {tab.trafficCount}
          </span>
        )}
        <button
          type="button"
          aria-label={`Close ${tab.name}`}
          title={`Close tab (${MOD}W)`}
          onClick={(e) => {
            e.stopPropagation();
            void close(tab.id);
          }}
          className={`ml-auto shrink-0 rounded p-0.5 hover:bg-neutral-200 ${
            active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'
          }`}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
    </WithContextMenu>
  );
}

export function TabStrip(): React.JSX.Element | null {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const seen = useTabsStore((s) => s.seen);
  const renameRequest = useTabsStore((s) => s.renameRequest);
  const create = useTabsStore((s) => s.create);
  const select = useTabsStore((s) => s.select);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Tabs → Rename Tab… renames the active tab.
  const [handledRename, setHandledRename] = useState(renameRequest);
  if (renameRequest !== handledRename) {
    setHandledRename(renameRequest);
    setRenamingId(activeTabId);
  }

  if (tabs.length === 0) return null;

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const index = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    if (next) {
      e.preventDefault();
      void select(next.id).then(() => document.getElementById(`tab-${next.id}`)?.focus());
    }
  };

  return (
    <div className="flex items-end gap-0.5 border-b border-neutral-300 bg-neutral-200 px-2 pt-1">
      <div
        role="tablist"
        aria-label="Proxy tabs"
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-end gap-0.5 overflow-x-auto"
      >
        {tabs.map((tab, index) => (
          <Tab
            key={tab.id}
            tab={tab}
            index={index}
            active={tab.id === activeTabId}
            unread={tab.trafficCount > (seen[tab.id] ?? tab.trafficCount)}
            renaming={renamingId === tab.id}
            onRename={() => setRenamingId(tab.id)}
            onRenameDone={() => setRenamingId(null)}
          />
        ))}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title={`New tab: debug another tool on its own port (${MOD}T)`}
        onClick={() => void create()}
        className="mb-1 shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-300 hover:text-neutral-800"
      >
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** "Show" handler for notices that point at a tab. */
export function showNoticeTab(): void {
  const { notice, clearNotice } = useUiStore.getState();
  if (notice?.tabId) void useTabsStore.getState().select(notice.tabId);
  clearNotice();
}
