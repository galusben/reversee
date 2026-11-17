// Tabs: each tab is an independent proxy session (its own listen port,
// destination, rules, scripts, breakpoints and traffic). This module is pure
// so the main process, the renderer and the MCP handlers share one set of
// rules for which settings are per tab, how tabs are named, and how a tab
// reference (id or name) resolves.
import { defaultSettings, sanitizeSettingsPatch, type AppSettings } from './settings-schema';

/** Settings shared by every tab (Preferences); everything else belongs to a tab. */
export const GLOBAL_SETTING_KEYS = [
  'theme',
  'mcpEnabled',
  'mcpAllowControl',
  'trafficCap',
] as const;
export type GlobalSettingKey = (typeof GLOBAL_SETTING_KEYS)[number];
export type GlobalSettings = Pick<AppSettings, GlobalSettingKey>;
export type TabSettings = Omit<AppSettings, GlobalSettingKey>;

export function isGlobalKey(key: string): key is GlobalSettingKey {
  return (GLOBAL_SETTING_KEYS as readonly string[]).includes(key);
}

/** Splits a (sanitized) settings patch into its global and per-tab parts. */
export function splitSettingsPatch(patch: Partial<AppSettings>): {
  global: Partial<GlobalSettings>;
  tab: Partial<TabSettings>;
} {
  const global: Record<string, unknown> = {};
  const tab: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (isGlobalKey(key)) global[key] = value;
    else tab[key] = value;
  }
  return { global: global as Partial<GlobalSettings>, tab: tab as Partial<TabSettings> };
}

export function pickTabSettings(settings: Partial<AppSettings>): Partial<TabSettings> {
  return splitSettingsPatch(settings).tab;
}

export const defaultTabSettings: TabSettings = pickTabSettings(defaultSettings) as TabSettings;

/** A tab as persisted: identity plus its own settings. */
export interface StoredTab {
  /** Stable, short and never reused: "t1", "t2", … */
  id: string;
  name: string;
  /** False while the name follows the destination; true once the user named the tab. */
  nameIsCustom: boolean;
  settings: TabSettings;
}

export interface StoredTabsState {
  activeTabId: string;
  /** The number the next new tab id gets (ids are never reused). */
  nextTabNumber: number;
  tabs: StoredTab[];
}

/** What the window and agents see of a tab: identity, config at a glance, and live counters. */
export interface TabSummary {
  id: string;
  name: string;
  nameIsCustom: boolean;
  running: boolean;
  /** Bound port while running. */
  port?: number;
  listenProtocol: AppSettings['listenProtocol'];
  listenPort: number;
  captureAll: boolean;
  /** `protocol://host:port`, or null in capture-anything mode / with no destination. */
  destination: string | null;
  trafficCount: number;
  pendingCount: number;
  /** Requests/responses held at a breakpoint right now. */
  heldCount: number;
  /** The last start/run failure, cleared on the next successful start. */
  error?: string;
}

export interface TabsSnapshot {
  activeTabId: string;
  tabs: TabSummary[];
}

export const MAX_TABS = 20;
export const MAX_TAB_NAME = 60;
const TAB_ID_RE = /^t\d+$/i;

export function tabIdFor(n: number): string {
  return `t${n}`;
}

/** The name a tab gets while the user has not named it. */
export function autoTabBaseName(settings: Pick<TabSettings, 'captureAll' | 'dest'>): string {
  if (settings.captureAll) return 'Capture anything';
  const dest = settings.dest.trim();
  return dest || 'New tab';
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * `base`, or `base #2`, `base #3`, … — the lowest suffix no other tab uses.
 * Two tabs on the same host are normal (one with mocks, one without; two
 * clients), so a collision is resolved rather than refused.
 */
export function uniqueTabName(base: string, takenNames: Iterable<string>): string {
  const taken = new Set([...takenNames].map(nameKey));
  if (!taken.has(nameKey(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} #${n}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

/** Why `name` cannot be used for a tab (null when it can). */
export function tabNameError(name: string, takenNames: Iterable<string>): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'A tab name cannot be empty';
  if (trimmed.length > MAX_TAB_NAME) return `A tab name can be at most ${MAX_TAB_NAME} characters`;
  // Ids resolve first, so a name shaped like an id could never be reached by name.
  if (TAB_ID_RE.test(trimmed)) return `"${trimmed}" looks like a tab id; choose another name`;
  const key = nameKey(trimmed);
  for (const taken of takenNames) {
    if (nameKey(taken) === key) return `Another tab is already called "${trimmed}"`;
  }
  return null;
}

/** Recomputes the auto names (custom names are kept), keeping every name unique. */
export function renameAutoTabs(tabs: StoredTab[]): StoredTab[] {
  const taken: string[] = tabs.filter((t) => t.nameIsCustom).map((t) => t.name);
  return tabs.map((tab) => {
    if (tab.nameIsCustom) return tab;
    const name = uniqueTabName(autoTabBaseName(tab.settings), taken);
    taken.push(name);
    return name === tab.name ? tab : { ...tab, name };
  });
}

/**
 * Finds a tab by id ("t2"), then by name (case-insensitive). Names are unique,
 * so the lookup is never ambiguous.
 */
export function resolveTabRef<T extends { id: string; name: string }>(
  tabs: readonly T[],
  ref: string
): T | undefined {
  const wanted = ref.trim();
  return (
    tabs.find((t) => t.id === wanted) ??
    tabs.find((t) => t.id.toLowerCase() === wanted.toLowerCase()) ??
    tabs.find((t) => nameKey(t.name) === nameKey(wanted))
  );
}

/** A listen port no other tab is configured with, starting from `from`. */
export function nextFreeListenPort(tabs: readonly StoredTab[], from = 8000): number {
  const used = new Set(tabs.map((t) => t.settings.listenPort));
  let port = from;
  while (used.has(port) && port < 65535) port++;
  return port;
}

export function newStoredTab(
  number: number,
  settings: Partial<TabSettings>,
  others: readonly StoredTab[]
): StoredTab {
  const full: TabSettings = { ...defaultTabSettings, ...settings };
  return {
    id: tabIdFor(number),
    name: uniqueTabName(
      autoTabBaseName(full),
      others.map((t) => t.name)
    ),
    nameIsCustom: false,
    settings: full,
  };
}

/**
 * Validates a stored tabs state: per-tab settings are sanitized, duplicate or
 * malformed ids dropped, names made unique, and the active id repaired.
 * Returns null when nothing usable is stored.
 */
export function sanitizeTabsState(raw: unknown): StoredTabsState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r['tabs'])) return null;
  const ids = new Set<string>();
  let maxNumber = 0;
  const tabs: StoredTab[] = [];
  for (const item of r['tabs'].slice(0, MAX_TABS)) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    const id = t['id'];
    if (typeof id !== 'string' || !TAB_ID_RE.test(id) || ids.has(id)) continue;
    ids.add(id);
    maxNumber = Math.max(maxNumber, Number(id.slice(1)));
    const custom = t['nameIsCustom'] === true && typeof t['name'] === 'string';
    tabs.push({
      id,
      name: custom ? (t['name'] as string).trim().slice(0, MAX_TAB_NAME) : '',
      nameIsCustom: custom,
      settings: {
        ...defaultTabSettings,
        ...pickTabSettings(sanitizeSettingsPatch(t['settings'])),
      },
    });
  }
  if (tabs.length === 0) return null;

  // Custom names must be unique too: a later duplicate falls back to an auto name.
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (!tab.nameIsCustom) continue;
    if (!tab.name || seen.has(nameKey(tab.name)) || TAB_ID_RE.test(tab.name)) {
      tab.nameIsCustom = false;
    } else {
      seen.add(nameKey(tab.name));
    }
  }
  const named = renameAutoTabs(tabs);

  const active = r['activeTabId'];
  const next = r['nextTabNumber'];
  return {
    activeTabId:
      typeof active === 'string' && ids.has(active) ? active : (named[0] as StoredTab).id,
    nextTabNumber:
      typeof next === 'number' && Number.isInteger(next) && next > maxNumber ? next : maxNumber + 1,
    tabs: named,
  };
}
