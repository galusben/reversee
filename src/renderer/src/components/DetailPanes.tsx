import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { ArrowDownLeft, ArrowUpRight, Boxes, KeyRound, Radio, Terminal } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { MonacoView, bodyToText } from './MonacoView';
import { useTrafficEntry } from '../lib/use-traffic-entry';
import { WithContextMenu } from './ui/ContextMenu';
import { languageForContentType } from '../lib/content-type';
import { findTokens, type FoundToken } from '../../../shared/decode';
import { formatBytes, formatDuration, timingPhases, totalMs } from '../../../shared/timings';
import type {
  GrpcMessage,
  GrpcView,
  RequestView,
  ResponseView,
  Timings,
  TrafficEntry,
  WebSocketView,
} from '../../../shared/types';

/** Human-readable gRPC status names for the common codes. */
const GRPC_STATUS: Record<number, string> = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

function GrpcMessageBlock({ msg, label }: { msg: GrpcMessage; label: string }): React.JSX.Element {
  const body = msg.decodeError
    ? `// decode failed: ${msg.decodeError}\n// ${msg.raw?.length ?? 0} raw bytes`
    : msg.json !== undefined
      ? JSON.stringify(msg.json, null, 2)
      : `// no matching proto spec — ${msg.raw?.length ?? 0} raw bytes`;
  return (
    <div className="mb-3 rounded-md border border-neutral-200">
      <div className="border-b border-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600">
        {label}
        {msg.compressed && <span className="ml-2 text-neutral-400">compressed</span>}
        {msg.decodeError && <span className="ml-2 text-red-600">decode error</span>}
      </div>
      <pre className="overflow-auto p-2.5 font-mono text-xs leading-5">{body}</pre>
    </div>
  );
}

function GrpcPane({ grpc }: { grpc: GrpcView }): React.JSX.Element {
  const ok = grpc.status === 0;
  const statusName = grpc.status !== undefined ? (GRPC_STATUS[grpc.status] ?? '') : undefined;
  return (
    <div className="h-full overflow-auto p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono font-medium text-neutral-700">{grpc.method}</span>
        {grpc.status !== undefined && (
          <span className={ok ? 'text-emerald-700' : 'text-red-600'}>
            status {grpc.status} {statusName}
            {grpc.statusMessage ? ` — ${grpc.statusMessage}` : ''}
          </span>
        )}
        {grpc.matchedSpecId === undefined && (
          <span className="text-amber-600">no proto spec matched — import one to decode</span>
        )}
      </div>
      <GrpcMessages
        className="mb-4"
        title="Request"
        messages={grpc.requestMessages}
        total={grpc.requestMessageCount}
      />
      <GrpcMessages
        title="Response"
        messages={grpc.responseMessages}
        total={grpc.responseMessageCount}
      />
    </div>
  );
}

/**
 * One direction of a gRPC call. A long stream keeps only its most recent
 * messages; `total` (absent on older entries) is how many were seen, so the
 * shown ones are numbered by their position in the whole stream.
 */
function GrpcMessages({
  title,
  messages,
  total,
  className,
}: {
  title: string;
  messages: GrpcMessage[];
  total?: number;
  className?: string;
}): React.JSX.Element {
  const count = Math.max(total ?? 0, messages.length);
  const offset = count - messages.length;
  return (
    <section className={className}>
      <h4 className="mb-1.5 text-xs font-semibold uppercase text-neutral-500">
        {title} ({count})
      </h4>
      {offset > 0 && (
        <p className="mb-1.5 text-xs text-neutral-500">
          showing the most recent {messages.length} of {count}
        </p>
      )}
      {messages.map((m, i) => (
        <GrpcMessageBlock key={offset + i} msg={m} label={`message ${offset + i + 1}`} />
      ))}
      {messages.length === 0 && (
        <p className="text-xs text-neutral-400">No {title.toLowerCase()} messages.</p>
      )}
    </section>
  );
}

function WebSocketPane({ ws }: { ws: WebSocketView }): React.JSX.Element {
  const dropped = ws.messageCount - ws.messages.length;
  return (
    <div className="h-full overflow-auto p-3">
      <div className="mb-2 flex items-center gap-3 text-xs text-neutral-500">
        <span>
          {ws.messageCount} message{ws.messageCount === 1 ? '' : 's'}
        </span>
        <span className={ws.closed ? 'text-neutral-500' : 'text-emerald-700'}>
          {ws.closed ? 'closed' : 'open'}
        </span>
        {dropped > 0 && <span>showing the most recent {ws.messages.length}</span>}
      </div>
      {ws.messages.length === 0 && <p className="text-xs text-neutral-400">No messages yet.</p>}
      <ul className="space-y-1" aria-label="WebSocket messages">
        {ws.messages.map((m, i) => {
          const sent = m.from === 'client';
          const body =
            m.opcode === 'text'
              ? (m.text ?? '(not decoded)')
              : m.opcode === 'close'
                ? `close ${m.closeCode ?? ''} ${m.text ?? ''}`.trim()
                : m.opcode === 'binary'
                  ? `binary, ${formatBytes(m.size)}`
                  : m.opcode;
          return (
            <li
              key={i}
              className={`flex items-start gap-2 rounded border px-2 py-1 font-mono text-xs ${
                sent ? 'border-blue-200 bg-blue-50' : 'border-neutral-200'
              }`}
            >
              {sent ? (
                <ArrowUpRight
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600"
                  aria-label="sent"
                />
              ) : (
                <ArrowDownLeft
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700"
                  aria-label="received"
                />
              )}
              <span className="min-w-0 grow whitespace-pre-wrap break-all">
                {body}
                {m.truncated && <span className="ml-1 text-amber-600">(truncated)</span>}
              </span>
              <span className="shrink-0 tabular-nums text-neutral-400">
                {formatBytes(m.size)} · +{(m.atMs / 1000).toFixed(2)}s
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const PHASE_COLOR: Record<string, string> = {
  dns: 'bg-indigo-500',
  connect: 'bg-amber-600',
  tls: 'bg-fuchsia-500',
  wait: 'bg-emerald-600',
  download: 'bg-blue-600',
};

/** Where the time went: one bar per phase, positioned on a shared time axis. */
function TimingsPane({ timings }: { timings: Timings }): React.JSX.Element {
  const phases = timingPhases(timings);
  const total = totalMs(timings) ?? 0;
  const text = timingsText(timings);
  return (
    <WithContextMenu
      items={[
        { label: 'Copy To Clipboard', onSelect: () => void window.reversee.copyToClipboard(text) },
      ]}
    >
      <div className="h-full overflow-auto p-3">
        {phases.length > 0 && total > 0 && (
          <table className="mb-4 w-full text-xs" aria-label="Timing waterfall">
            <tbody>
              {phases.map((p) => (
                <tr key={p.key}>
                  <td className="w-40 py-1 pr-3 text-neutral-600">{p.label}</td>
                  <td className="py-1">
                    <div className="relative h-3 rounded bg-neutral-100">
                      <div
                        className={`absolute top-0 h-3 rounded ${PHASE_COLOR[p.key]}`}
                        style={{
                          left: `${(p.startMs / total) * 100}%`,
                          width: `${Math.max(0.5, (p.durationMs / total) * 100)}%`,
                        }}
                      />
                    </div>
                  </td>
                  <td className="w-24 py-1 pl-3 text-right tabular-nums text-neutral-600">
                    {formatDuration(p.durationMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <pre className="font-mono text-xs leading-5">{text}</pre>
      </div>
    </WithContextMenu>
  );
}

/** Errors and console output of the user interceptors that ran for this exchange. */
function ConsolePane({ entry }: { entry: TrafficEntry }): React.JSX.Element {
  return (
    <div className="h-full overflow-auto p-3 font-mono text-xs leading-5">
      {entry.interceptorErrors?.map((e, i) => (
        <div key={`e${i}`} role="alert" className="mb-1 rounded bg-red-50 px-2 py-1 text-red-700">
          {e.phase} interceptor error: {e.message}
        </div>
      ))}
      {entry.interceptorLogs?.map((line, i) => (
        <div key={`l${i}`} className="whitespace-pre-wrap break-all text-neutral-700">
          {line}
        </div>
      ))}
    </div>
  );
}

/** One line of context above the tabs: what happened to this exchange. */
function Summary({ entry }: { entry: TrafficEntry }): React.JSX.Element {
  const notes: Array<{ text: string; tone: string }> = [];
  if (entry.pending) notes.push({ text: 'in flight', tone: 'text-blue-600' });
  if (entry.mocked) notes.push({ text: 'answered by a mock rule', tone: 'text-amber-700' });
  if (entry.replay) notes.push({ text: 'replayed', tone: 'text-neutral-500' });
  if (entry.imported) notes.push({ text: 'imported from HAR', tone: 'text-neutral-500' });
  if (entry.clientAborted) notes.push({ text: 'client disconnected', tone: 'text-amber-700' });
  if (entry.connectorError) {
    notes.push({ text: String(entry.connectorError), tone: 'text-red-600' });
  }
  const target = entry.request.target;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-neutral-100 px-3 py-1 text-xs"
      aria-label="Request summary"
    >
      <span className="font-mono font-medium text-neutral-700">
        {entry.request.method} {entry.request.url}
      </span>
      {target && (
        <span className="text-neutral-400">
          → {target.protocol}://{target.host}:{target.port}
        </span>
      )}
      {notes.map((n) => (
        <span key={n.text} className={n.tone}>
          {n.text}
        </span>
      ))}
    </div>
  );
}

function DecodedView({ tokens }: { tokens: FoundToken[] }): React.JSX.Element {
  return (
    <div className="h-full overflow-auto p-3">
      {tokens.map((t, i) => (
        <div key={i} className="mb-4 rounded-md border border-neutral-200">
          <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-xs">
            <KeyRound className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
            <span className="font-medium text-neutral-700">{t.location}</span>
            {t.jwt.expiresAt && (
              <span className={t.jwt.expired ? 'text-red-600' : 'text-emerald-700'}>
                {t.jwt.expired ? 'expired' : 'valid'} · exp {t.jwt.expiresAt}
              </span>
            )}
          </div>
          <pre className="overflow-auto p-2.5 font-mono text-xs leading-5">
            {JSON.stringify({ header: t.jwt.header, payload: t.jwt.payload }, null, 2)}
          </pre>
        </div>
      ))}
      <p className="text-xs text-neutral-400">
        JWTs are decoded for inspection — signatures are not verified.
      </p>
    </div>
  );
}

function headerText(view: RequestView | ResponseView): string {
  let text = '';
  for (const key of Object.keys(view.headers)) {
    const value = view.headers[key];
    text += `${key} : ${Array.isArray(value) ? value.join(', ') : value}\n`;
  }
  return text;
}

// Same fields and ms conversions as the 1.x timings panel.
export function timingsText(timings: Timings): string {
  const ms = (v?: number): string => `${v ? v / 1_000_000.0 : 0} ms`;
  return (
    `Start timestamp : ${timings.start}\n` +
    `DNS Lookup : ${ms(timings.dnsLookup)}\n` +
    `Time till first byte received : ${ms(timings.firstByte)}\n` +
    `TCP Connection : ${ms(timings.tcpConnection)}\n` +
    `TLS handshake : ${ms(timings.tlsHandshake)}\n` +
    `Total : ${ms(timings.total)}\n`
  );
}

function CopyablePre({ text }: { text: string }): React.JSX.Element {
  return (
    <WithContextMenu
      items={[
        { label: 'Copy To Clipboard', onSelect: () => void window.reversee.copyToClipboard(text) },
      ]}
    >
      <pre className="h-full overflow-auto p-3 font-mono text-xs leading-5">{text}</pre>
    </WithContextMenu>
  );
}

function BodyView({
  view,
  entryKey,
}: {
  view: RequestView | ResponseView;
  entryKey: string;
}): React.JSX.Element {
  const [formatted, setFormatted] = useState(false);
  const text = bodyToText(view.body);
  const contentTypeHeader = view.headers['content-type'];
  const language = languageForContentType(
    Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader
  );
  const decodeError = 'decodeError' in view ? view.decodeError : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1">
        <button
          type="button"
          onClick={() => setFormatted(false)}
          className={`rounded px-2 py-0.5 text-xs ${!formatted ? 'bg-neutral-200 font-medium' : 'text-neutral-500 hover:bg-neutral-100'}`}
        >
          Plain
        </button>
        <button
          type="button"
          onClick={() => setFormatted(true)}
          className={`rounded px-2 py-0.5 text-xs ${formatted ? 'bg-neutral-200 font-medium' : 'text-neutral-500 hover:bg-neutral-100'}`}
        >
          Formatted
        </button>
        <div className="grow" />
        {view.size !== undefined && view.size > 0 && (
          <span className="text-xs text-neutral-400">{formatBytes(view.size)}</span>
        )}
        {view.truncated && (
          <span className="text-xs text-amber-600">body truncated at 2 MB for display</span>
        )}
        {decodeError && (
          <span className="text-xs text-red-600" title={decodeError}>
            decompression failed — showing raw bytes
          </span>
        )}
        <button
          type="button"
          onClick={() => void window.reversee.copyToClipboard(text)}
          className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100"
        >
          Copy
        </button>
      </div>
      <div className="min-h-0 grow">
        <MonacoView
          key={`${entryKey}-${formatted}`}
          value={text}
          language={formatted ? language : 'plaintext'}
          format={formatted}
        />
      </div>
    </div>
  );
}

const tabClass =
  'border-b-2 border-transparent px-3 py-1.5 text-sm text-neutral-500 hover:text-neutral-800 ' +
  'data-[state=active]:border-blue-600 data-[state=active]:font-medium data-[state=active]:text-neutral-900';

export function DetailPanes(): React.JSX.Element {
  const selectedId = useProxyStore((s) => s.selectedId);
  // Bodies are fetched from main for the selected row only. While the next
  // selection loads, the previous entry stays up rather than flashing empty.
  const { entry } = useTrafficEntry(selectedId);

  if (selectedId === null || !entry) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-sm text-neutral-400">
        {selectedId === null ? 'Select a request to inspect it.' : ''}
      </div>
    );
  }

  const tokens = findTokens(entry);
  const hasConsole = Boolean(entry.interceptorErrors?.length || entry.interceptorLogs?.length);

  return (
    <Tabs.Root
      defaultValue={entry.grpc ? 'grpc' : entry.ws ? 'websocket' : 'response-body'}
      className="flex h-full flex-col bg-white"
    >
      <Summary entry={entry} />
      <Tabs.List className="flex border-b border-neutral-200 px-2" aria-label="Request details">
        {entry.grpc && (
          <Tabs.Trigger className={tabClass} value="grpc">
            <span className="flex items-center gap-1">
              <Boxes className="h-3.5 w-3.5" aria-hidden /> gRPC
            </span>
          </Tabs.Trigger>
        )}
        {entry.ws && (
          <Tabs.Trigger className={tabClass} value="websocket">
            <span className="flex items-center gap-1">
              <Radio className="h-3.5 w-3.5" aria-hidden /> Messages
            </span>
          </Tabs.Trigger>
        )}
        <Tabs.Trigger className={tabClass} value="response-body">
          Response Body
        </Tabs.Trigger>
        <Tabs.Trigger className={tabClass} value="response-headers">
          Response Headers
        </Tabs.Trigger>
        <Tabs.Trigger className={tabClass} value="request-body">
          Request Body
        </Tabs.Trigger>
        <Tabs.Trigger className={tabClass} value="request-headers">
          Request Headers
        </Tabs.Trigger>
        <Tabs.Trigger className={tabClass} value="timings">
          Timings
        </Tabs.Trigger>
        {tokens.length > 0 && (
          <Tabs.Trigger className={tabClass} value="decoded">
            <span className="flex items-center gap-1">
              <KeyRound className="h-3.5 w-3.5" aria-hidden /> Decoded
            </span>
          </Tabs.Trigger>
        )}
        {hasConsole && (
          <Tabs.Trigger className={tabClass} value="console">
            <span
              className={`flex items-center gap-1 ${entry.interceptorErrors?.length ? 'text-red-600' : ''}`}
            >
              <Terminal className="h-3.5 w-3.5" aria-hidden /> Interceptor
            </span>
          </Tabs.Trigger>
        )}
      </Tabs.List>
      {entry.ws && (
        <Tabs.Content value="websocket" className="min-h-0 grow">
          <WebSocketPane ws={entry.ws} />
        </Tabs.Content>
      )}
      {hasConsole && (
        <Tabs.Content value="console" className="min-h-0 grow">
          <ConsolePane entry={entry} />
        </Tabs.Content>
      )}
      {entry.grpc && (
        <Tabs.Content value="grpc" className="min-h-0 grow">
          <GrpcPane grpc={entry.grpc} />
        </Tabs.Content>
      )}
      <Tabs.Content value="response-body" className="min-h-0 grow">
        <BodyView view={entry.response} entryKey={`response-${selectedId}`} />
      </Tabs.Content>
      <Tabs.Content value="response-headers" className="min-h-0 grow">
        <CopyablePre text={headerText(entry.response)} />
      </Tabs.Content>
      <Tabs.Content value="request-body" className="min-h-0 grow">
        <BodyView view={entry.request} entryKey={`request-${selectedId}`} />
      </Tabs.Content>
      <Tabs.Content value="request-headers" className="min-h-0 grow">
        <CopyablePre text={headerText(entry.request)} />
      </Tabs.Content>
      <Tabs.Content value="timings" className="min-h-0 grow">
        <TimingsPane timings={entry.timings} />
      </Tabs.Content>
      {tokens.length > 0 && (
        <Tabs.Content value="decoded" className="min-h-0 grow">
          <DecodedView tokens={tokens} />
        </Tabs.Content>
      )}
    </Tabs.Root>
  );
}
