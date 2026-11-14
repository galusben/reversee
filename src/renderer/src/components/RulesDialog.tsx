import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { Plus, Trash2 } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { useUiStore } from '../stores/uiStore';
import { Modal, inputClass, primaryButton, secondaryButton } from './ui/Modal';
import { headersToText, textToHeaders } from './ReplayDialog';
import { isValidPort, regexError } from '../../../shared/settings-schema';
import type { MockRule, Protocol, RouteRule } from '../../../shared/types';

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Drafts hold raw text so a half-typed port or pattern is not thrown away;
// they become rules only when valid.
interface RouteDraft {
  id: string;
  enabled: boolean;
  hostPattern: string;
  pathPattern: string;
  destProtocol: Protocol;
  dest: string;
  destPort: string;
}

interface MockDraft {
  id: string;
  enabled: boolean;
  method: string;
  pathPattern: string;
  statusCode: string;
  headers: string;
  body: string;
  delayMs: string;
}

const toRouteDraft = (r: RouteRule): RouteDraft => ({
  id: r.id,
  enabled: r.enabled,
  hostPattern: r.hostPattern ?? '',
  pathPattern: r.pathPattern ?? '',
  destProtocol: r.destProtocol,
  dest: r.dest,
  destPort: String(r.destPort),
});

const toMockDraft = (m: MockRule): MockDraft => ({
  id: m.id,
  enabled: m.enabled,
  method: m.method ?? '',
  pathPattern: m.pathPattern,
  statusCode: String(m.statusCode),
  headers: headersToText(m.headers),
  body: m.body,
  delayMs: m.delayMs ? String(m.delayMs) : '',
});

/** The first problem with a route draft, or null when it can be saved. */
export function routeProblem(d: RouteDraft): string | null {
  if (d.hostPattern && regexError(d.hostPattern)) return 'host pattern is not a valid regex';
  if (d.pathPattern && regexError(d.pathPattern)) return 'path pattern is not a valid regex';
  if (!d.dest.trim()) return 'destination host is required';
  if (!isValidPort(Number(d.destPort))) return 'port must be 1–65535';
  return null;
}

export function mockProblem(d: MockDraft): string | null {
  if (!d.pathPattern) return 'path pattern is required';
  if (regexError(d.pathPattern)) return 'path pattern is not a valid regex';
  const status = Number(d.statusCode);
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'status must be 100–599';
  if (d.delayMs && !(Number.isInteger(Number(d.delayMs)) && Number(d.delayMs) >= 0)) {
    return 'delay must be a whole number of milliseconds';
  }
  return null;
}

const toRoute = (d: RouteDraft): RouteRule => ({
  id: d.id,
  enabled: d.enabled,
  ...(d.hostPattern ? { hostPattern: d.hostPattern } : {}),
  ...(d.pathPattern ? { pathPattern: d.pathPattern } : {}),
  destProtocol: d.destProtocol,
  dest: d.dest.trim(),
  destPort: Number(d.destPort),
});

const toMock = (d: MockDraft): MockRule => ({
  id: d.id,
  enabled: d.enabled,
  ...(d.method ? { method: d.method } : {}),
  pathPattern: d.pathPattern,
  statusCode: Number(d.statusCode),
  headers: textToHeaders(d.headers),
  body: d.body,
  ...(Number(d.delayMs) > 0 ? { delayMs: Number(d.delayMs) } : {}),
});

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const tabClass =
  'border-b-2 border-transparent px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-800 ' +
  'data-[state=active]:border-blue-600 data-[state=active]:font-medium data-[state=active]:text-neutral-900';
const small = `${inputClass} py-0.5 font-mono text-xs`;

function Problem({ text }: { text: string | null }): React.JSX.Element | null {
  return text ? (
    <div role="alert" className="mt-1 text-xs text-red-600">
      {text}
    </div>
  ) : null;
}

export function RulesDialog(): React.JSX.Element | null {
  const open = useUiStore((s) => s.rulesOpen);
  const setOpen = useUiStore((s) => s.setRulesOpen);
  if (!open) return null;
  // Mounted per opening, so the drafts always start from the saved rules.
  return <RulesEditor onClose={() => setOpen(false)} />;
}

function RulesEditor({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useProxyStore((s) => s.settings);
  const running = useProxyStore((s) => s.running);
  const updateSettings = useProxyStore((s) => s.updateSettings);
  const [routes, setRoutes] = useState<RouteDraft[]>(() =>
    (settings?.routes ?? []).map(toRouteDraft)
  );
  const [mocks, setMocks] = useState<MockDraft[]>(() => (settings?.mocks ?? []).map(toMockDraft));

  const patchRoute = (id: string, patch: Partial<RouteDraft>): void =>
    setRoutes((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const patchMock = (id: string, patch: Partial<MockDraft>): void =>
    setMocks((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const invalid = routes.some((r) => routeProblem(r)) || mocks.some((m) => mockProblem(m));
  const save = async (): Promise<void> => {
    await updateSettings({ routes: routes.map(toRoute), mocks: mocks.map(toMock) });
    onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Routes and mocks"
      width="w-[880px]"
      description={
        running
          ? 'Changes apply the next time the proxy starts.'
          : 'Send some requests to a different upstream, or answer them without one. Patterns are regular expressions; the first matching rule wins.'
      }
    >
      <Tabs.Root defaultValue="routes">
        <Tabs.List className="mb-3 flex border-b border-neutral-200" aria-label="Rule kind">
          <Tabs.Trigger className={tabClass} value="routes">
            Routes ({routes.length})
          </Tabs.Trigger>
          <Tabs.Trigger className={tabClass} value="mocks">
            Mocks ({mocks.length})
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="routes">
          {routes.length === 0 && (
            <p className="mb-3 text-xs text-neutral-400">
              No routes. Every request goes to the destination in the settings bar.
            </p>
          )}
          {routes.map((r, i) => (
            <div key={r.id} className="mb-2 rounded border border-neutral-200 p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  type="checkbox"
                  aria-label={`Route ${i + 1} enabled`}
                  checked={r.enabled}
                  onChange={(e) => patchRoute(r.id, { enabled: e.target.checked })}
                />
                <input
                  aria-label={`Route ${i + 1} host pattern`}
                  placeholder="host regex (any)"
                  className={`w-40 ${small}`}
                  value={r.hostPattern}
                  onChange={(e) => patchRoute(r.id, { hostPattern: e.target.value })}
                />
                <input
                  aria-label={`Route ${i + 1} path pattern`}
                  placeholder="path regex (any), e.g. ^/api/v2/"
                  className={`min-w-0 grow ${small}`}
                  value={r.pathPattern}
                  onChange={(e) => patchRoute(r.id, { pathPattern: e.target.value })}
                />
                <span className="text-neutral-400">→</span>
                <select
                  aria-label={`Route ${i + 1} protocol`}
                  className={small}
                  value={r.destProtocol}
                  onChange={(e) => patchRoute(r.id, { destProtocol: e.target.value as Protocol })}
                >
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
                <input
                  aria-label={`Route ${i + 1} destination host`}
                  placeholder="host"
                  className={`w-40 ${small}`}
                  value={r.dest}
                  onChange={(e) => patchRoute(r.id, { dest: e.target.value })}
                />
                <input
                  aria-label={`Route ${i + 1} destination port`}
                  placeholder="port"
                  inputMode="numeric"
                  className={`w-16 ${small}`}
                  value={r.destPort}
                  onChange={(e) => patchRoute(r.id, { destPort: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={`Delete route ${i + 1}`}
                  onClick={() => setRoutes((prev) => prev.filter((x) => x.id !== r.id))}
                  className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <Problem text={routeProblem(r)} />
            </div>
          ))}
          <button
            type="button"
            className={`flex items-center gap-1 ${secondaryButton}`}
            onClick={() =>
              setRoutes((prev) => [
                ...prev,
                {
                  id: newId(),
                  enabled: true,
                  hostPattern: '',
                  pathPattern: '',
                  destProtocol: 'http',
                  dest: '',
                  destPort: '80',
                },
              ])
            }
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add route
          </button>
        </Tabs.Content>

        <Tabs.Content value="mocks">
          {mocks.length === 0 && (
            <p className="mb-3 text-xs text-neutral-400">
              No mocks. A mock answers matching requests itself; the upstream is never contacted.
            </p>
          )}
          {mocks.map((m, i) => (
            <div key={m.id} className="mb-2 rounded border border-neutral-200 p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  type="checkbox"
                  aria-label={`Mock ${i + 1} enabled`}
                  checked={m.enabled}
                  onChange={(e) => patchMock(m.id, { enabled: e.target.checked })}
                />
                <select
                  aria-label={`Mock ${i + 1} method`}
                  className={small}
                  value={m.method}
                  onChange={(e) => patchMock(m.id, { method: e.target.value })}
                >
                  <option value="">Any</option>
                  {METHODS.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <input
                  aria-label={`Mock ${i + 1} path pattern`}
                  placeholder="path regex, e.g. ^/api/flags"
                  className={`min-w-0 grow ${small}`}
                  value={m.pathPattern}
                  onChange={(e) => patchMock(m.id, { pathPattern: e.target.value })}
                />
                <span className="text-xs text-neutral-500">status</span>
                <input
                  aria-label={`Mock ${i + 1} status`}
                  inputMode="numeric"
                  className={`w-14 ${small}`}
                  value={m.statusCode}
                  onChange={(e) => patchMock(m.id, { statusCode: e.target.value })}
                />
                <span className="text-xs text-neutral-500">delay ms</span>
                <input
                  aria-label={`Mock ${i + 1} delay`}
                  inputMode="numeric"
                  className={`w-16 ${small}`}
                  value={m.delayMs}
                  onChange={(e) => patchMock(m.id, { delayMs: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={`Delete mock ${i + 1}`}
                  onClick={() => setMocks((prev) => prev.filter((x) => x.id !== m.id))}
                  className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <textarea
                  aria-label={`Mock ${i + 1} headers`}
                  placeholder={'content-type: application/json'}
                  className={`h-20 w-1/3 ${small}`}
                  value={m.headers}
                  onChange={(e) => patchMock(m.id, { headers: e.target.value })}
                />
                <textarea
                  aria-label={`Mock ${i + 1} body`}
                  placeholder="response body"
                  className={`h-20 grow ${small}`}
                  value={m.body}
                  onChange={(e) => patchMock(m.id, { body: e.target.value })}
                />
              </div>
              <Problem text={mockProblem(m)} />
            </div>
          ))}
          <button
            type="button"
            className={`flex items-center gap-1 ${secondaryButton}`}
            onClick={() =>
              setMocks((prev) => [
                ...prev,
                {
                  id: newId(),
                  enabled: true,
                  method: '',
                  pathPattern: '',
                  statusCode: '200',
                  headers: 'content-type: application/json',
                  body: '',
                  delayMs: '',
                },
              ])
            }
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add mock
          </button>
        </Tabs.Content>
      </Tabs.Root>

      <div className="mt-4 flex justify-end gap-2">
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
