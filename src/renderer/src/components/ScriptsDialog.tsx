// Scripts: the request and response interceptors. One screen to write them,
// try them against a captured request, and switch them on or off.
import { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, FlaskConical, Plus } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { useUiStore } from '../stores/uiStore';
import { MonacoView } from './MonacoView';
import { Modal, inputClass, primaryButton, secondaryButton } from './ui/Modal';
import { SCRIPT_FIELDS, SCRIPT_SNIPPETS, appendSnippet } from '../lib/script-snippets';
import type { AppSettings } from '../../../shared/settings-schema';
import type { ScriptTrialOutcome } from '../../../shared/ipc';
import type { ScriptKind, TrafficEntry } from '../../../shared/types';

const FIELDS = {
  request: { enabled: 'interceptRequest', code: 'requestInterceptor' },
  response: { enabled: 'interceptResponse', code: 'responseInterceptor' },
} as const;

const COPY = {
  request: {
    title: 'Request script',
    hint: 'Runs on each request before it is sent on.',
    toggle: 'Run on every request',
  },
  response: {
    title: 'Response script',
    hint: 'Runs on each response before the client gets it.',
    toggle: 'Run on every response',
  },
} as const;

/** How many of the latest captured requests the "try it" picker offers. */
const TRIAL_CHOICES = 50;

type Draft = Pick<
  AppSettings,
  'interceptRequest' | 'requestInterceptor' | 'interceptResponse' | 'responseInterceptor'
>;

/**
 * The most recent live exchange's failure for one script, if it failed. A
 * later clean run clears it, so the warning never outlives the problem.
 */
export function lastScriptError(traffic: TrafficEntry[], kind: ScriptKind): string | null {
  for (let i = traffic.length - 1; i >= 0; i--) {
    const entry = traffic[i];
    if (entry.mocked || entry.replay || entry.imported || entry.pending) continue;
    return entry.interceptorErrors?.find((e) => e.phase === kind)?.message ?? null;
  }
  return null;
}

function trialLabel(entry: TrafficEntry): string {
  const status = entry.response.statusCode ? ` · ${entry.response.statusCode}` : '';
  return `${entry.request.method} ${entry.request.url}${status}`;
}

function TrialResult({
  kind,
  outcome,
}: {
  kind: ScriptKind;
  outcome: ScriptTrialOutcome;
}): React.JSX.Element {
  if (!outcome.ok) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not run the script: {outcome.error}
      </p>
    );
  }
  const body = kind === 'request' ? outcome.after.request.body : outcome.after.response?.body;
  return (
    <div className="space-y-2 text-sm" aria-label="Try it result">
      {outcome.error ? (
        <p role="alert" className="text-red-600">
          The script failed: {outcome.error}
        </p>
      ) : outcome.changes.length === 0 ? (
        <p className="text-neutral-600">The script ran and changed nothing for this request.</p>
      ) : (
        <p className="text-emerald-700">
          The script ran and made {outcome.changes.length} change
          {outcome.changes.length === 1 ? '' : 's'}:
        </p>
      )}
      {outcome.changes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs text-neutral-700">
          {outcome.changes.map((change, i) => (
            <li key={i} className="break-all">
              {change}
            </li>
          ))}
        </ul>
      )}
      {outcome.logs.length > 0 && (
        <div>
          <div className="text-xs font-medium text-neutral-500">Console output</div>
          <pre className="max-h-24 overflow-auto rounded bg-neutral-100 p-2 text-xs">
            {outcome.logs.join('\n')}
          </pre>
        </div>
      )}
      {!outcome.error && body !== undefined && (
        <details>
          <summary className="cursor-pointer text-xs text-blue-600">
            Show the {kind} body after the script
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-100 p-2 text-xs">
            {body || '(empty)'}
          </pre>
        </details>
      )}
    </div>
  );
}

export function ScriptsDialog(): React.JSX.Element | null {
  const open = useUiStore((s) => s.scriptsOpen);
  const setOpen = useUiStore((s) => s.setScriptsOpen);
  if (!open) return null;
  // Mounted per opening, so the drafts always start from the saved scripts.
  return <ScriptsEditor onClose={() => setOpen(false)} />;
}

function ScriptsEditor({ onClose }: { onClose: () => void }): React.JSX.Element | null {
  const settings = useProxyStore((s) => s.settings);
  const running = useProxyStore((s) => s.running);
  const traffic = useProxyStore((s) => s.traffic);
  const updateSettings = useProxyStore((s) => s.updateSettings);

  const [draft, setDraft] = useState<Draft | null>(() =>
    settings
      ? {
          interceptRequest: settings.interceptRequest,
          requestInterceptor: settings.requestInterceptor,
          interceptResponse: settings.interceptResponse,
          responseInterceptor: settings.responseInterceptor,
        }
      : null
  );
  const [kind, setKind] = useState<ScriptKind>(() =>
    settings && settings.interceptResponse && !settings.interceptRequest ? 'response' : 'request'
  );
  const [trialId, setTrialId] = useState<number | null>(null);
  const [trial, setTrial] = useState<{ kind: ScriptKind; outcome: ScriptTrialOutcome } | null>(
    null
  );
  const [trying, setTrying] = useState(false);
  // What the editors are loaded with. It changes only when this screen writes
  // the code itself (an inserted example), never on a keystroke: feeding each
  // keystroke back into the editor can drop characters typed in the meantime.
  const [loaded, setLoaded] = useState(() => ({
    request: settings?.requestInterceptor ?? '',
    response: settings?.responseInterceptor ?? '',
  }));

  const choices = useMemo(
    () =>
      traffic
        .filter((e) => !e.pending && !e.ws)
        .slice(-TRIAL_CHOICES)
        .reverse(),
    [traffic]
  );

  if (!settings || !draft) return null;

  const field = FIELDS[kind];
  const code = draft[field.code];
  const enabled = draft[field.enabled];
  const savedOn = settings[field.enabled];
  const lastError = savedOn ? lastScriptError(traffic, kind) : null;
  const picked = choices.find((e) => e.trafficId === trialId) ?? choices[0];

  const setCode = (value: string): void => {
    setDraft({ ...draft, [field.code]: value });
    // A result describes the code it ran, not what is typed after it.
    setTrial(null);
  };
  const insert = (snippet: string): void => {
    const next = appendSnippet(code, snippet);
    setCode(next);
    setLoaded({ ...loaded, [kind]: next });
  };
  const switchTo = (next: ScriptKind): void => {
    // The editor is remounted per script; reload it with what was typed so far.
    setLoaded({ request: draft.requestInterceptor, response: draft.responseInterceptor });
    setKind(next);
  };
  const save = async (): Promise<void> => {
    await updateSettings(draft);
    onClose();
  };
  const tryIt = async (): Promise<void> => {
    if (!picked) return;
    setTrying(true);
    try {
      const outcome = await window.reversee.tryScript(kind, code, picked.trafficId);
      setTrial({ kind, outcome });
    } catch (error) {
      setTrial({ kind, outcome: { ok: false, error: (error as Error).message } });
    } finally {
      setTrying(false);
    }
  };

  const tab = (value: ScriptKind, Icon: typeof ArrowUpRight): React.JSX.Element => {
    const on = draft[FIELDS[value].enabled];
    return (
      <button
        type="button"
        role="tab"
        aria-selected={kind === value}
        onClick={() => switchTo(value)}
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
        <span className="grow">
          <span className="block text-sm font-medium text-neutral-900">{COPY[value].title}</span>
          <span className="block text-xs text-neutral-500">{COPY[value].hint}</span>
        </span>
        <span
          className={`rounded-full px-2 text-xs font-medium leading-5 ${
            on ? 'bg-emerald-600 text-white' : 'bg-neutral-200 text-neutral-600'
          }`}
        >
          {on ? 'On' : 'Off'}
        </span>
      </button>
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Scripts"
      width="w-[980px]"
      description={
        <>
          A few lines of JavaScript that change requests on their way out, or responses on their way
          back: add a header, rewrite a path, edit a JSON field. For a fixed reply with no code, use
          Routes &amp; Mocks.
        </>
      }
    >
      <div role="tablist" aria-label="Script" className="mb-3 flex gap-2">
        {tab('request', ArrowUpRight)}
        {tab('response', ArrowDownLeft)}
      </div>

      <div className="mb-2 flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setDraft({ ...draft, [field.enabled]: e.target.checked })}
          />
          {COPY[kind].toggle}
        </label>
        {!enabled && (
          <span className="text-xs text-neutral-500">
            Off: the script is kept but does not run.
          </span>
        )}
        {lastError && (
          <span role="status" className="truncate text-xs text-red-600" title={lastError}>
            last run failed: {lastError}
          </span>
        )}
      </div>

      <div className="flex gap-3">
        <div className="h-64 min-w-0 grow overflow-hidden rounded-md border border-neutral-200">
          <MonacoView
            key={kind}
            value={loaded[kind]}
            language="javascript"
            readOnly={false}
            onChange={setCode}
          />
        </div>
        <div className="w-64 shrink-0 space-y-3 text-xs">
          <div>
            <div className="mb-1 font-medium text-neutral-700">You can read and change</div>
            <ul className="space-y-0.5">
              {SCRIPT_FIELDS[kind].map((f) => (
                <li key={f.name} title={f.hint}>
                  <code className="font-mono text-neutral-900">{f.name}</code>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 font-medium text-neutral-700">Insert an example</div>
            <div className="flex flex-wrap gap-1">
              {SCRIPT_SNIPPETS[kind].map((s) => (
                <button
                  key={s.label}
                  type="button"
                  title={s.code}
                  onClick={() => insert(s.code)}
                  className="flex items-center gap-1 rounded-full border border-neutral-300 px-2 py-0.5 text-neutral-700 hover:bg-neutral-50"
                >
                  <Plus className="h-3 w-3" aria-hidden />
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-neutral-500">
            A body is bytes: use <code className="font-mono">.toString()</code> for text. Each run
            has 1 second. <code className="font-mono">console.log</code> output shows on the
            request&apos;s Interceptor tab.
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-neutral-200 p-3">
        <div className="mb-2 flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-neutral-500" aria-hidden />
          <span className="text-sm font-medium text-neutral-800">Try it</span>
          <span className="text-xs text-neutral-500">
            Runs the script above on a captured request. Nothing is sent.
          </span>
        </div>
        {choices.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Capture a request first, then you can try the script on it here.
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <select
              aria-label="Captured request to try the script on"
              className={`min-w-0 grow ${inputClass}`}
              value={picked?.trafficId}
              onChange={(e) => {
                setTrialId(Number(e.target.value));
                setTrial(null);
              }}
            >
              {choices.map((e) => (
                <option key={e.trafficId} value={e.trafficId}>
                  {trialLabel(e)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={secondaryButton}
              disabled={trying}
              onClick={() => void tryIt()}
            >
              {trying ? 'Running…' : 'Try it'}
            </button>
          </div>
        )}
        {trial && trial.kind === kind && (
          <div className="mt-3">
            <TrialResult kind={kind} outcome={trial.outcome} />
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-neutral-500">
          {running
            ? 'Saving applies the scripts to the running proxy at once. No restart needed.'
            : 'Scripts take effect when the proxy is started.'}
        </span>
        <button type="button" className={secondaryButton} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={primaryButton} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}
