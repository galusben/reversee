import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  Plus,
  Reply,
  Split,
  Trash2,
} from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { useUiStore, type RuleSeed } from '../stores/uiStore';
import { Modal, inputClass, primaryButton, secondaryButton } from './ui/Modal';
import { headersToText, textToHeaders } from './ReplayDialog';
import { isValidPort, regexError } from '../../../shared/settings-schema';
import {
  describeHostPattern,
  describePathPattern,
  hostPattern,
  pathPattern,
  type HostMatch,
  type PathMatch,
} from '../../../shared/rule-patterns';
import { newRuleId } from '../../../shared/rule-input';
import type { MockRule, Protocol, RouteRule, TrafficEntry } from '../../../shared/types';

// Drafts hold raw text so a half-typed port or pattern is not thrown away;
// they become rules only when valid. Patterns are edited as a plain match
// ("starts with /api") and stored as the regex the proxy runs.
export interface RouteDraft {
  id: string;
  name: string;
  enabled: boolean;
  pathMatch: PathMatch;
  path: string;
  hostMatch: HostMatch;
  host: string;
  destProtocol: Protocol;
  dest: string;
  destPort: string;
}

export interface MockDraft {
  id: string;
  name: string;
  enabled: boolean;
  method: string;
  pathMatch: PathMatch;
  path: string;
  statusCode: string;
  headers: string;
  body: string;
  delayMs: string;
}

const toRouteDraft = (r: RouteRule): RouteDraft => {
  const path = describePathPattern(r.pathPattern ?? '');
  const host = describeHostPattern(r.hostPattern ?? '');
  return {
    id: r.id,
    name: r.name ?? '',
    enabled: r.enabled,
    pathMatch: path.match,
    path: path.value,
    hostMatch: host.match,
    host: host.value,
    destProtocol: r.destProtocol,
    dest: r.dest,
    destPort: String(r.destPort),
  };
};

const toMockDraft = (m: MockRule): MockDraft => {
  const path = describePathPattern(m.pathPattern);
  return {
    id: m.id,
    name: m.name ?? '',
    enabled: m.enabled,
    method: m.method ?? '',
    pathMatch: path.match,
    path: path.value,
    statusCode: String(m.statusCode),
    headers: headersToText(m.headers),
    body: m.body,
    delayMs: m.delayMs ? String(m.delayMs) : '',
  };
};

const routePathSource = (d: RouteDraft): string => (d.path ? pathPattern(d.pathMatch, d.path) : '');
const routeHostSource = (d: RouteDraft): string => (d.host ? hostPattern(d.hostMatch, d.host) : '');
const mockPathSource = (d: MockDraft): string => pathPattern(d.pathMatch, d.path);

/** The first problem with a route draft, or null when it can be saved. */
export function routeProblem(d: RouteDraft): string | null {
  if (d.host && regexError(routeHostSource(d)))
    return 'The host is not a valid regular expression.';
  if (d.path && regexError(routePathSource(d)))
    return 'The path is not a valid regular expression.';
  if (!d.path && !d.host)
    return 'Enter a path or a host, so this route does not take every request.';
  if (!d.dest.trim()) return 'Enter the server to send matching requests to.';
  if (!isValidPort(Number(d.destPort))) return 'The port must be between 1 and 65535.';
  return null;
}

export function mockProblem(d: MockDraft): string | null {
  if (!d.path) return 'Enter the path this mock answers, for example /api/flags.';
  if (regexError(mockPathSource(d))) return 'The path is not a valid regular expression.';
  const status = Number(d.statusCode);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return 'The status must be a number from 100 to 599.';
  }
  if (d.delayMs && !(Number.isInteger(Number(d.delayMs)) && Number(d.delayMs) >= 0)) {
    return 'The delay must be a whole number of milliseconds.';
  }
  return null;
}

const toRoute = (d: RouteDraft): RouteRule => ({
  id: d.id,
  ...(d.name.trim() ? { name: d.name.trim() } : {}),
  enabled: d.enabled,
  ...(d.host ? { hostPattern: routeHostSource(d) } : {}),
  ...(d.path ? { pathPattern: routePathSource(d) } : {}),
  destProtocol: d.destProtocol,
  dest: d.dest.trim(),
  destPort: Number(d.destPort),
});

const toMock = (d: MockDraft): MockRule => ({
  id: d.id,
  ...(d.name.trim() ? { name: d.name.trim() } : {}),
  enabled: d.enabled,
  ...(d.method ? { method: d.method } : {}),
  pathPattern: mockPathSource(d),
  statusCode: Number(d.statusCode),
  headers: textToHeaders(d.headers),
  body: d.body,
  ...(Number(d.delayMs) > 0 ? { delayMs: Number(d.delayMs) } : {}),
});

const blankMock = (patch: Partial<MockDraft> = {}): MockDraft => ({
  id: newRuleId(),
  name: '',
  enabled: true,
  method: '',
  pathMatch: 'exact',
  path: '',
  statusCode: '200',
  headers: 'content-type: application/json',
  body: '',
  delayMs: '',
  ...patch,
});

const blankRoute = (patch: Partial<RouteDraft> = {}): RouteDraft => ({
  id: newRuleId(),
  name: '',
  enabled: true,
  pathMatch: 'prefix',
  path: '',
  hostMatch: 'exact',
  host: '',
  destProtocol: 'http',
  dest: '',
  destPort: '80',
  ...patch,
});

/** One-click starting points shown when there are no mocks yet. */
const MOCK_STARTERS: { label: string; draft: Partial<MockDraft> }[] = [
  {
    label: 'JSON response',
    draft: { name: 'JSON response', path: '/api/example', body: '{\n  "ok": true\n}' },
  },
  {
    label: 'Server error (500)',
    draft: {
      name: 'Server error',
      path: '/api/example',
      statusCode: '500',
      body: '{\n  "error": "Internal Server Error"\n}',
    },
  },
  {
    label: 'Slow response (2 s)',
    draft: { name: 'Slow response', path: '/api/example', delayMs: '2000', body: '{}' },
  },
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const STATUSES: [string, string][] = [
  ['200', 'OK'],
  ['201', 'Created'],
  ['204', 'No Content'],
  ['301', 'Moved Permanently'],
  ['302', 'Found'],
  ['400', 'Bad Request'],
  ['401', 'Unauthorized'],
  ['403', 'Forbidden'],
  ['404', 'Not Found'],
  ['429', 'Too Many Requests'],
  ['500', 'Internal Server Error'],
  ['502', 'Bad Gateway'],
  ['503', 'Service Unavailable'],
];
const BODY_TYPES: [string, string][] = [
  ['JSON', 'application/json'],
  ['Text', 'text/plain'],
  ['HTML', 'text/html'],
];
const PATH_MATCH_LABELS: [PathMatch, string][] = [
  ['exact', 'is exactly'],
  ['prefix', 'starts with'],
  ['contains', 'contains'],
  ['regex', 'matches regex'],
];

const field = `${inputClass} py-1 text-sm`;
const mono = `${field} font-mono text-xs`;
const sectionLabel = 'w-28 shrink-0 pt-1.5 text-xs font-semibold uppercase tracking-wide';
const iconButton =
  'rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent';

function contentTypeOf(headers: string): string {
  return (textToHeaders(headers.toLowerCase())['content-type'] ?? '').split(';')[0]?.trim() ?? '';
}

function withContentType(headers: string, type: string): string {
  const rest = headers
    .split('\n')
    .filter((line) => line.trim() && !/^\s*content-type\s*:/i.test(line));
  return [`content-type: ${type}`, ...rest].join('\n');
}

function jsonError(body: string): string | null {
  if (!body.trim()) return null;
  try {
    JSON.parse(body);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function safeRegex(source: string, flags = ''): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** How many captured requests a mock draft would have answered. */
export function countMockMatches(d: MockDraft, traffic: TrafficEntry[]): number {
  const path = d.path ? safeRegex(mockPathSource(d)) : null;
  if (!path) return 0;
  return traffic.filter(
    (e) => (!d.method || e.request.method.toUpperCase() === d.method) && path.test(e.request.url)
  ).length;
}

export function countRouteMatches(d: RouteDraft, traffic: TrafficEntry[]): number {
  if (!d.path && !d.host) return 0;
  const path = d.path ? safeRegex(routePathSource(d)) : null;
  const host = d.host ? safeRegex(routeHostSource(d), 'i') : null;
  if ((d.path && !path) || (d.host && !host)) return 0;
  return traffic.filter((e) => {
    const header = e.request.headers['host'];
    const name = (Array.isArray(header) ? header[0] : header)?.replace(/:\d+$/, '') ?? '';
    return (!path || path.test(e.request.url)) && (!host || host.test(name));
  }).length;
}

function mockSummary(d: MockDraft): string {
  const words = Object.fromEntries(PATH_MATCH_LABELS) as Record<PathMatch, string>;
  const when = d.path ? `${d.method || 'Any method'} · path ${words[d.pathMatch]} ${d.path}` : '';
  const delay = Number(d.delayMs) > 0 ? ` after ${d.delayMs} ms` : '';
  return when ? `${when} → ${d.statusCode}${delay}` : 'New mock';
}

function routeSummary(d: RouteDraft): string {
  const words = Object.fromEntries(PATH_MATCH_LABELS) as Record<PathMatch, string>;
  const when = [
    d.path ? `path ${words[d.pathMatch]} ${d.path}` : '',
    d.host ? `host ${d.hostMatch === 'exact' ? 'is' : 'matches'} ${d.host}` : '',
  ].filter(Boolean);
  if (when.length === 0) return 'New route';
  const target = d.dest ? `${d.destProtocol}://${d.dest}:${d.destPort}` : '…';
  return `${when.join(' and ')} → ${target}`;
}

function Problem({ text }: { text: string | null }): React.JSX.Element | null {
  return text ? (
    <div role="alert" className="mt-2 text-xs text-red-600">
      {text}
    </div>
  ) : null;
}

function MatchCount({ count, total }: { count: number; total: number }): React.JSX.Element | null {
  if (total === 0) return null;
  return (
    <span
      className={`shrink-0 text-xs ${count > 0 ? 'text-emerald-700' : 'text-neutral-400'}`}
      title="Compared with the requests currently in the traffic list"
    >
      {count > 0
        ? `Matches ${count} of ${total} captured request${total === 1 ? '' : 's'}`
        : 'Matches no captured request'}
    </span>
  );
}

function PathMatchFields({
  label,
  match,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  match: PathMatch;
  value: string;
  placeholder: string;
  onChange: (patch: { pathMatch?: PathMatch; path?: string }) => void;
}): React.JSX.Element {
  return (
    <>
      <span className="text-sm text-neutral-600">Path</span>
      <select
        aria-label={`${label} path match`}
        className={field}
        value={match}
        onChange={(e) => onChange({ pathMatch: e.target.value as PathMatch })}
      >
        {PATH_MATCH_LABELS.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
      <input
        aria-label={`${label} path`}
        placeholder={match === 'regex' ? '^/api/v[12]/' : placeholder}
        className={`min-w-0 grow ${mono}`}
        value={value}
        onChange={(e) => onChange({ path: e.target.value })}
      />
    </>
  );
}

/** The header row every rule card shares: on/off, name, order, duplicate, delete. */
function CardHeader({
  label,
  enabled,
  name,
  summary,
  expanded,
  index,
  count,
  onToggleExpanded,
  onEnabled,
  onMove,
  onDuplicate,
  onDelete,
}: {
  label: string;
  enabled: boolean;
  name: string;
  summary: string;
  expanded: boolean;
  index: number;
  count: number;
  onToggleExpanded: () => void;
  onEnabled: (enabled: boolean) => void;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <input
        type="checkbox"
        aria-label={`${label} enabled`}
        title={enabled ? 'On. Untick to switch this rule off without deleting it.' : 'Off'}
        checked={enabled}
        onChange={(e) => onEnabled(e.target.checked)}
      />
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label.toLowerCase()}`}
        onClick={onToggleExpanded}
        className="flex min-w-0 grow items-center gap-1.5 text-left"
      >
        <Chevron className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
        <span className="shrink-0 text-xs text-neutral-400">{index + 1}.</span>
        {name && <span className="shrink-0 text-sm font-medium text-neutral-800">{name}</span>}
        <span
          className={`truncate font-mono text-xs ${enabled ? 'text-neutral-600' : 'text-neutral-400 line-through'}`}
        >
          {summary}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Move ${label.toLowerCase()} up`}
        title="Move up (checked earlier)"
        disabled={index === 0}
        onClick={() => onMove(-1)}
        className={iconButton}
      >
        <ArrowUp className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`Move ${label.toLowerCase()} down`}
        title="Move down (checked later)"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
        className={iconButton}
      >
        <ArrowDown className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`Duplicate ${label.toLowerCase()}`}
        title="Duplicate"
        onClick={onDuplicate}
        className={iconButton}
      >
        <Copy className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`Delete ${label.toLowerCase()}`}
        title="Delete"
        onClick={onDelete}
        className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function MockCard({
  d,
  label,
  traffic,
  patch,
}: {
  d: MockDraft;
  label: string;
  traffic: TrafficEntry[];
  patch: (patch: Partial<MockDraft>) => void;
}): React.JSX.Element {
  const type = contentTypeOf(d.headers);
  const badJson = type === 'application/json' ? jsonError(d.body) : null;
  const [showHeaders, setShowHeaders] = useState(false);
  return (
    <div className="border-t border-neutral-200 px-3 pb-3 pt-2">
      <input
        aria-label={`${label} name`}
        placeholder="Name (optional), e.g. Feature flags"
        className={`mb-2 w-full ${field}`}
        value={d.name}
        onChange={(e) => patch({ name: e.target.value })}
      />
      <div className="flex gap-2">
        <div className={`${sectionLabel} text-blue-700`}>When</div>
        <div className="flex min-w-0 grow flex-wrap items-center gap-1.5">
          <span className="text-sm text-neutral-600">Method</span>
          <select
            aria-label={`${label} method`}
            className={field}
            value={d.method}
            onChange={(e) => patch({ method: e.target.value })}
          >
            <option value="">Any</option>
            {METHODS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <PathMatchFields
            label={label}
            match={d.pathMatch}
            value={d.path}
            placeholder="/api/flags"
            onChange={patch}
          />
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <div className={`${sectionLabel} text-emerald-700`}>Respond with</div>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm text-neutral-600">Status</span>
            <input
              aria-label={`${label} status`}
              inputMode="numeric"
              list="reversee-mock-statuses"
              className={`w-20 ${mono}`}
              value={d.statusCode}
              onChange={(e) => patch({ statusCode: e.target.value })}
            />
            <span className="text-sm text-neutral-600">after</span>
            <input
              aria-label={`${label} delay`}
              inputMode="numeric"
              placeholder="0"
              className={`w-20 ${mono}`}
              value={d.delayMs}
              onChange={(e) => patch({ delayMs: e.target.value })}
            />
            <span className="text-sm text-neutral-600">ms</span>
            <span className="ml-auto text-sm text-neutral-600">Body is</span>
            <div className="flex overflow-hidden rounded-md border border-neutral-300">
              {BODY_TYPES.map(([text, mime]) => (
                <button
                  key={mime}
                  type="button"
                  aria-pressed={type === mime}
                  onClick={() => patch({ headers: withContentType(d.headers, mime) })}
                  className={`px-2 py-1 text-xs ${type === mime ? 'bg-blue-600 text-white' : 'text-neutral-600 hover:bg-neutral-50'}`}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
          <textarea
            aria-label={`${label} body`}
            placeholder={type === 'application/json' ? '{ "ok": true }' : 'Response body'}
            spellCheck={false}
            className={`mt-1.5 h-28 w-full ${mono}`}
            value={d.body}
            onChange={(e) => patch({ body: e.target.value })}
          />
          <div className="mt-1 flex items-center gap-3 text-xs">
            <button
              type="button"
              className="text-blue-700 hover:underline"
              aria-expanded={showHeaders}
              onClick={() => setShowHeaders((v) => !v)}
            >
              {showHeaders
                ? 'Hide headers'
                : `Edit headers (${Object.keys(textToHeaders(d.headers)).length})`}
            </button>
            {type === 'application/json' && d.body.trim() && !badJson && (
              <button
                type="button"
                className="text-blue-700 hover:underline"
                onClick={() => patch({ body: JSON.stringify(JSON.parse(d.body), null, 2) })}
              >
                Format JSON
              </button>
            )}
            {badJson && (
              <span className="text-amber-700">The body is not valid JSON: {badJson}</span>
            )}
          </div>
          {showHeaders && (
            <textarea
              aria-label={`${label} headers`}
              placeholder="name: value, one per line"
              spellCheck={false}
              className={`mt-1 h-16 w-full ${mono}`}
              value={d.headers}
              onChange={(e) => patch({ headers: e.target.value })}
            />
          )}
        </div>
      </div>
      <div className="mt-1 flex items-start justify-between gap-3">
        <Problem text={mockProblem(d)} />
        <span className="ml-auto mt-2">
          <MatchCount count={countMockMatches(d, traffic)} total={traffic.length} />
        </span>
      </div>
    </div>
  );
}

function RouteCard({
  d,
  label,
  traffic,
  defaultTarget,
  patch,
}: {
  d: RouteDraft;
  label: string;
  traffic: TrafficEntry[];
  defaultTarget: string;
  patch: (patch: Partial<RouteDraft>) => void;
}): React.JSX.Element {
  return (
    <div className="border-t border-neutral-200 px-3 pb-3 pt-2">
      <input
        aria-label={`${label} name`}
        placeholder="Name (optional), e.g. Local checkout service"
        className={`mb-2 w-full ${field}`}
        value={d.name}
        onChange={(e) => patch({ name: e.target.value })}
      />
      <div className="flex gap-2">
        <div className={`${sectionLabel} text-blue-700`}>When</div>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-1.5">
            <PathMatchFields
              label={label}
              match={d.pathMatch}
              value={d.path}
              placeholder="/api/v2 (leave empty for any path)"
              onChange={patch}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-sm text-neutral-600">Host</span>
            <select
              aria-label={`${label} host match`}
              className={field}
              value={d.hostMatch}
              onChange={(e) => patch({ hostMatch: e.target.value as HostMatch })}
            >
              <option value="exact">is exactly</option>
              <option value="regex">matches regex</option>
            </select>
            <input
              aria-label={`${label} host`}
              placeholder="api.example.com (leave empty for any host)"
              className={`min-w-0 grow ${mono}`}
              value={d.host}
              onChange={(e) => patch({ host: e.target.value })}
            />
          </div>
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <div className={`${sectionLabel} text-emerald-700`}>Send to</div>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              aria-label={`${label} protocol`}
              className={field}
              value={d.destProtocol}
              onChange={(e) => {
                const destProtocol = e.target.value as Protocol;
                // Follow the protocol's default port unless a custom one was typed.
                const followsDefault = d.destPort === '80' || d.destPort === '443' || !d.destPort;
                patch({
                  destProtocol,
                  ...(followsDefault ? { destPort: destProtocol === 'https' ? '443' : '80' } : {}),
                });
              }}
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
            <input
              aria-label={`${label} destination host`}
              placeholder="localhost"
              className={`min-w-0 grow ${mono}`}
              value={d.dest}
              onChange={(e) => patch({ dest: e.target.value })}
            />
            <span className="text-sm text-neutral-600">port</span>
            <input
              aria-label={`${label} destination port`}
              inputMode="numeric"
              className={`w-20 ${mono}`}
              value={d.destPort}
              onChange={(e) => patch({ destPort: e.target.value })}
            />
          </div>
          {defaultTarget && (
            <p className="mt-1 text-xs text-neutral-400">
              Instead of {defaultTarget}. The path and query are forwarded unchanged.
            </p>
          )}
        </div>
      </div>
      <div className="mt-1 flex items-start justify-between gap-3">
        <Problem text={routeProblem(d)} />
        <span className="ml-auto mt-2">
          <MatchCount count={countRouteMatches(d, traffic)} total={traffic.length} />
        </span>
      </div>
    </div>
  );
}

type Kind = 'mocks' | 'routes';

function move<T>(list: T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return list;
  const next = list.slice();
  [next[index], next[to]] = [next[to] as T, next[index] as T];
  return next;
}

export function RulesDialog(): React.JSX.Element | null {
  const open = useUiStore((s) => s.rulesOpen);
  const seed = useUiStore((s) => s.rulesSeed);
  const setOpen = useUiStore((s) => s.setRulesOpen);
  if (!open) return null;
  // Mounted per opening, so the drafts always start from the saved rules.
  return <RulesEditor seed={seed} onClose={() => setOpen(false)} />;
}

function RulesEditor({
  seed,
  onClose,
}: {
  seed: RuleSeed | null;
  onClose: () => void;
}): React.JSX.Element {
  const settings = useProxyStore((s) => s.settings);
  const running = useProxyStore((s) => s.running);
  const traffic = useProxyStore((s) => s.traffic);
  const updateSettings = useProxyStore((s) => s.updateSettings);

  const seeded = useMemo(
    () => ({
      mock:
        seed?.kind === 'mock' ? blankMock(toMockDraft({ ...seed.rule, id: newRuleId() })) : null,
      route:
        seed?.kind === 'route' ? blankRoute(toRouteDraft({ ...seed.rule, id: newRuleId() })) : null,
    }),
    [seed]
  );
  const [mocks, setMocks] = useState<MockDraft[]>(() => [
    ...(seeded.mock ? [seeded.mock] : []),
    ...(settings?.mocks ?? []).map(toMockDraft),
  ]);
  const [routes, setRoutes] = useState<RouteDraft[]>(() => [
    ...(seeded.route ? [seeded.route] : []),
    ...(settings?.routes ?? []).map(toRouteDraft),
  ]);
  const [kind, setKind] = useState<Kind>(() => {
    if (seed) return seed.kind === 'mock' ? 'mocks' : 'routes';
    return (settings?.mocks.length ?? 0) === 0 && (settings?.routes.length ?? 0) > 0
      ? 'routes'
      : 'mocks';
  });
  // A few rules are shown open; a long list starts collapsed to its summaries.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const ids = [...mocks, ...routes].map((r) => r.id);
    const fresh = [seeded.mock?.id, seeded.route?.id].filter((x): x is string => !!x);
    return new Set(ids.length <= 2 ? ids : fresh);
  });
  const toggleExpanded = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const addMock = (draft: Partial<MockDraft> = {}): void => {
    const mock = blankMock(draft);
    setMocks((prev) => [...prev, mock]);
    setExpanded((prev) => new Set(prev).add(mock.id));
  };
  const addRoute = (draft: Partial<RouteDraft> = {}): void => {
    const route = blankRoute(draft);
    setRoutes((prev) => [...prev, route]);
    setExpanded((prev) => new Set(prev).add(route.id));
  };

  const defaultTarget = settings?.dest
    ? `${settings.destProtocol}://${settings.dest}:${settings.destPort}`
    : '';
  const invalid = routes.some((r) => routeProblem(r)) || mocks.some((m) => mockProblem(m));
  const save = async (): Promise<void> => {
    await updateSettings({ routes: routes.map(toRoute), mocks: mocks.map(toMock) });
    onClose();
  };

  const tab = (value: Kind, Icon: typeof Reply, title: string, count: number, hint: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={kind === value}
      onClick={() => setKind(value)}
      className={`flex grow basis-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-left ${
        kind === value
          ? 'border-blue-600 bg-blue-50'
          : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50'
      }`}
    >
      <Icon
        className={`mt-0.5 h-4 w-4 shrink-0 ${kind === value ? 'text-blue-700' : 'text-neutral-400'}`}
        aria-hidden
      />
      <span>
        <span className="block text-sm font-medium text-neutral-900">
          {title} ({count})
        </span>
        <span className="block text-xs text-neutral-500">{hint}</span>
      </span>
    </button>
  );

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Routes and mocks"
      width="w-[860px]"
      description={
        <>
          Decide what happens to a request before it reaches{' '}
          {defaultTarget ? (
            <span className="font-mono text-xs">{defaultTarget}</span>
          ) : (
            'the destination'
          )}
          . Rules are checked top to bottom and the first match wins; mocks are checked before
          routes.
        </>
      }
    >
      <datalist id="reversee-mock-statuses">
        {STATUSES.map(([code, text]) => (
          <option key={code} value={code}>
            {text}
          </option>
        ))}
      </datalist>

      <div role="tablist" aria-label="Rule kind" className="mb-3 flex gap-2">
        {tab(
          'mocks',
          Reply,
          'Mocks',
          mocks.length,
          'Answer with a response you write. The server is not contacted.'
        )}
        {tab('routes', Split, 'Routes', routes.length, 'Send some requests to a different server.')}
      </div>

      {kind === 'mocks' && (
        <div role="tabpanel" aria-label="Mocks">
          {mocks.length === 0 && (
            <div className="mb-3 rounded-lg border border-dashed border-neutral-300 px-4 py-5 text-center">
              <p className="text-sm text-neutral-700">No mocks yet.</p>
              <p className="mx-auto mt-1 max-w-lg text-xs text-neutral-500">
                A mock answers a request itself, so you can fake an endpoint that does not exist
                yet, force an error, or slow a call down. Start from an example, or right-click a
                captured request and choose “Mock This Response”.
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {MOCK_STARTERS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className={secondaryButton}
                    onClick={() => addMock(s.draft)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {mocks.map((m, i) => {
            const label = `Mock ${i + 1}`;
            const open = expanded.has(m.id);
            return (
              <div key={m.id} className="mb-2 rounded-lg border border-neutral-200">
                <CardHeader
                  label={label}
                  enabled={m.enabled}
                  name={m.name}
                  summary={mockSummary(m)}
                  expanded={open}
                  index={i}
                  count={mocks.length}
                  onToggleExpanded={() => toggleExpanded(m.id)}
                  onEnabled={(enabled) =>
                    setMocks((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled } : x)))
                  }
                  onMove={(delta) => setMocks((prev) => move(prev, i, delta))}
                  onDuplicate={() =>
                    addMock({ ...m, id: newRuleId(), name: m.name && `${m.name} copy` })
                  }
                  onDelete={() => setMocks((prev) => prev.filter((x) => x.id !== m.id))}
                />
                {open ? (
                  <MockCard
                    d={m}
                    label={label}
                    traffic={traffic}
                    patch={(patch) =>
                      setMocks((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...patch } : x)))
                    }
                  />
                ) : (
                  <div className="px-3 pb-1.5">
                    <Problem text={mockProblem(m)} />
                  </div>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className={`flex items-center gap-1 ${secondaryButton}`}
            onClick={() => addMock()}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add mock
          </button>
        </div>
      )}

      {kind === 'routes' && (
        <div role="tabpanel" aria-label="Routes">
          {routes.length === 0 && (
            <div className="mb-3 rounded-lg border border-dashed border-neutral-300 px-4 py-5 text-center">
              <p className="text-sm text-neutral-700">No routes yet.</p>
              <p className="mx-auto mt-1 max-w-lg text-xs text-neutral-500">
                Every request goes to {defaultTarget || 'the destination in the settings bar'}. Add
                a route to send part of the traffic somewhere else, for example requests starting
                with /api/v2 to a service running on your machine.
              </p>
              <button
                type="button"
                className={`mt-3 ${secondaryButton}`}
                onClick={() =>
                  addRoute({
                    name: 'Local service',
                    path: '/api/v2',
                    dest: 'localhost',
                    destPort: '3000',
                  })
                }
              >
                Example: /api/v2 to localhost:3000
              </button>
            </div>
          )}
          {routes.map((r, i) => {
            const label = `Route ${i + 1}`;
            const open = expanded.has(r.id);
            return (
              <div key={r.id} className="mb-2 rounded-lg border border-neutral-200">
                <CardHeader
                  label={label}
                  enabled={r.enabled}
                  name={r.name}
                  summary={routeSummary(r)}
                  expanded={open}
                  index={i}
                  count={routes.length}
                  onToggleExpanded={() => toggleExpanded(r.id)}
                  onEnabled={(enabled) =>
                    setRoutes((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled } : x)))
                  }
                  onMove={(delta) => setRoutes((prev) => move(prev, i, delta))}
                  onDuplicate={() =>
                    addRoute({ ...r, id: newRuleId(), name: r.name && `${r.name} copy` })
                  }
                  onDelete={() => setRoutes((prev) => prev.filter((x) => x.id !== r.id))}
                />
                {open ? (
                  <RouteCard
                    d={r}
                    label={label}
                    traffic={traffic}
                    defaultTarget={defaultTarget}
                    patch={(patch) =>
                      setRoutes((prev) => prev.map((x) => (x.id === r.id ? { ...x, ...patch } : x)))
                    }
                  />
                ) : (
                  <div className="px-3 pb-1.5">
                    <Problem text={routeProblem(r)} />
                  </div>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className={`flex items-center gap-1 ${secondaryButton}`}
            onClick={() => addRoute()}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add route
          </button>
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-neutral-500">
          {running
            ? 'Saving applies the rules to the running proxy at once. No restart needed.'
            : 'Rules take effect when the proxy is started.'}
        </span>
        <button type="button" className={secondaryButton} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButton}
          disabled={invalid}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
