import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { KeyRound } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { MonacoView, bodyToText } from './MonacoView';
import { WithContextMenu } from './ui/ContextMenu';
import { languageForContentType } from '../lib/content-type';
import { findTokens, type FoundToken } from '../../../shared/decode';
import type { RequestView, ResponseView, Timings } from '../../../shared/types';

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
      <p className="text-xs text-neutral-400">JWTs are decoded for inspection — signatures are not verified.</p>
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
  const entry = useProxyStore((s) =>
    s.selectedId === null ? undefined : s.traffic.find((e) => e.trafficId === s.selectedId)
  );

  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-sm text-neutral-400">
        Select a request to inspect it.
      </div>
    );
  }

  const tokens = findTokens(entry);

  return (
    <Tabs.Root defaultValue="response-body" className="flex h-full flex-col bg-white">
      <Tabs.List className="flex border-b border-neutral-200 px-2" aria-label="Request details">
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
      </Tabs.List>
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
        <CopyablePre text={timingsText(entry.timings)} />
      </Tabs.Content>
      {tokens.length > 0 && (
        <Tabs.Content value="decoded" className="min-h-0 grow">
          <DecodedView tokens={tokens} />
        </Tabs.Content>
      )}
    </Tabs.Root>
  );
}
