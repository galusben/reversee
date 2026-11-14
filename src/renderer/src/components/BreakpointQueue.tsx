import { useState } from 'react';
import { useBreakpointStore } from '../stores/breakpointStore';
import { bodyToText } from './MonacoView';
import type { BreakpointHit } from '../../../shared/ipc';

interface HeaderRow {
  key: string;
  value: string;
}

function toRows(hit: BreakpointHit): HeaderRow[] {
  return Object.keys(hit.headers).map((key) => {
    const raw = hit.headers[key];
    return { key, value: Array.isArray(raw) ? raw.join(', ') : (raw ?? '') };
  });
}

/** Editor for the request (or response) at the head of the held queue. Replaces the
 * per-hit BrowserWindows of 1.x (which leaked when never resumed). */
export function BreakpointQueue(): React.JSX.Element | null {
  const hits = useBreakpointStore((s) => s.hits);
  const hit = hits[0];
  if (!hit) return null;
  // Keyed by hit id so the form state resets for each held request.
  return <HitEditor key={hit.id} hit={hit} queueLength={hits.length} />;
}

function HitEditor({
  hit,
  queueLength,
}: {
  hit: BreakpointHit;
  queueLength: number;
}): React.JSX.Element {
  const resume = useBreakpointStore((s) => s.resume);
  const [url, setUrl] = useState(hit.url);
  const [method, setMethod] = useState(hit.method);
  const [rows, setRows] = useState<HeaderRow[]>(() => toRows(hit));
  const [body, setBody] = useState(() => bodyToText(hit.body));
  const isResponse = hit.phase === 'response';
  const [status, setStatus] = useState(String(hit.statusCode ?? 200));
  const statusCode = Number(status);
  const statusValid = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599;

  const setRow = (index: number, patch: Partial<HeaderRow>): void => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const submit = (): void => {
    const headers: Record<string, string> = {};
    for (const row of rows) {
      if (row.key) headers[row.key] = row.value;
    }
    void resume(hit.id, {
      url,
      method,
      headers,
      body,
      ...(isResponse ? { statusCode } : {}),
    });
  };

  return (
    <div
      role="region"
      aria-label={isResponse ? 'Held response' : 'Held request'}
      className="border-b-2 border-amber-300 bg-amber-50 px-3 py-2"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
          {isResponse ? 'Response breakpoint' : 'Breakpoint'}{' '}
          {queueLength > 1 ? `(1 of ${queueLength} held)` : ''}
        </span>
        {isResponse ? (
          <>
            <input
              aria-label="Status code"
              inputMode="numeric"
              aria-invalid={!statusValid}
              className={`w-16 rounded border bg-white px-2 py-0.5 font-mono text-xs ${
                statusValid ? 'border-neutral-300' : 'border-red-500'
              }`}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            />
            <span className="grow truncate font-mono text-xs text-amber-900" title={hit.url}>
              response to {hit.method} {hit.url}
            </span>
          </>
        ) : (
          <>
            <select
              aria-label="Method"
              className="rounded border border-neutral-300 bg-white px-1 py-0.5 text-xs"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <input
              aria-label="URL"
              className="grow rounded border border-neutral-300 bg-white px-2 py-0.5 font-mono text-xs"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={isResponse && !statusValid}
          className="rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700"
        >
          Continue
        </button>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-amber-800">
          Headers ({rows.length}) and body
        </summary>
        <div className="mt-2 space-y-1">
          {rows.map((row, i) => (
            <div key={i} className="flex gap-1">
              <input
                aria-label={`Header ${i + 1} name`}
                className="w-56 rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-mono"
                value={row.key}
                onChange={(e) => setRow(i, { key: e.target.value })}
              />
              <input
                aria-label={`Header ${i + 1} value`}
                className="grow rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-mono"
                value={row.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setRows((prev) => [...prev, { key: '', value: '' }])}
            className="text-blue-700 hover:underline"
          >
            + add header
          </button>
          <textarea
            aria-label={isResponse ? 'Response body' : 'Request body'}
            className="mt-1 h-24 w-full rounded border border-neutral-300 bg-white p-1.5 font-mono"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
      </details>
    </div>
  );
}
