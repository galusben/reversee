import { useState } from 'react';
import { useProxyStore } from '../stores/proxyStore';
import { useUiStore } from '../stores/uiStore';
import { bodyToText } from './MonacoView';
import { Modal, inputClass, primaryButton, secondaryButton } from './ui/Modal';
import type { ReplayOverrides } from '../../../shared/ipc';
import type { Headers, TrafficEntry } from '../../../shared/types';

export function headersToText(headers: Headers | Record<string, string>): string {
  return Object.keys(headers)
    .map((key) => {
      const value = (headers as Headers)[key];
      return `${key}: ${Array.isArray(value) ? value.join(', ') : (value ?? '')}`;
    })
    .join('\n');
}

/** Parses "Name: value" lines; blank lines and lines without a colon are ignored. */
export function textToHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name) headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** Header overrides for replay: every edited header, plus null for each one removed. */
export function headerOverrides(
  original: Headers,
  edited: Record<string, string>
): Record<string, string | null> {
  const out: Record<string, string | null> = { ...edited };
  const kept = new Set(Object.keys(edited).map((k) => k.toLowerCase()));
  for (const key of Object.keys(original)) {
    if (!kept.has(key.toLowerCase())) out[key] = null;
  }
  return out;
}

export function ReplayDialog(): React.JSX.Element | null {
  const id = useUiStore((s) => s.replayEditorId);
  const close = useUiStore((s) => s.setReplayEditorId);
  const entry = useProxyStore((s) =>
    id === null ? undefined : s.traffic.find((e) => e.trafficId === id)
  );
  if (id === null || !entry) return null;
  // Keyed so the form starts from the chosen request every time it opens.
  return <ReplayForm key={id} entry={entry} onClose={() => close(null)} />;
}

function ReplayForm({
  entry,
  onClose,
}: {
  entry: TrafficEntry;
  onClose: () => void;
}): React.JSX.Element {
  const replay = useProxyStore((s) => s.replay);
  const [method, setMethod] = useState(entry.request.method);
  const [url, setUrl] = useState(entry.request.url);
  const [headers, setHeaders] = useState(() => headersToText(entry.request.headers));
  const [body, setBody] = useState(() => bodyToText(entry.request.body));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = entry.request.target;

  const send = async (): Promise<void> => {
    setSending(true);
    setError(null);
    const overrides: ReplayOverrides = {
      method: method.trim().toUpperCase() || entry.request.method,
      url,
      headers: headerOverrides(entry.request.headers, textToHeaders(headers)),
    };
    // Leave an untouched body alone so binary payloads are resent byte for byte.
    if (body !== bodyToText(entry.request.body)) overrides.body = body;
    const result = await replay(entry.trafficId, overrides);
    setSending(false);
    if (result.ok) onClose();
    else setError(result.error);
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Edit and replay"
      description={
        target
          ? `Sends the edited request straight to ${target.protocol}://${target.host}:${target.port} and records the result as a new entry.`
          : 'This request has no recorded upstream, so it cannot be replayed.'
      }
    >
      <div className="mb-2 flex gap-2">
        <input
          aria-label="Replay method"
          className={`w-24 font-mono ${inputClass}`}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        />
        <input
          aria-label="Replay URL"
          className={`min-w-0 grow font-mono ${inputClass}`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <label className="mb-1 block text-xs font-medium text-neutral-500" htmlFor="replay-headers">
        Headers (one per line, Name: value)
      </label>
      <textarea
        id="replay-headers"
        className={`mb-2 h-32 w-full font-mono ${inputClass}`}
        value={headers}
        onChange={(e) => setHeaders(e.target.value)}
      />
      <label className="mb-1 block text-xs font-medium text-neutral-500" htmlFor="replay-body">
        Body
      </label>
      <textarea
        id="replay-body"
        className={`mb-3 h-32 w-full font-mono ${inputClass}`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700"
        >
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButton}
          disabled={sending || !target}
          onClick={() => void send()}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </Modal>
  );
}
