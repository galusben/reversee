import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { MonacoView } from './MonacoView';
import type { AppSettings } from '../../../shared/settings-schema';

const FIELDS = {
  request: { enabled: 'interceptRequest', code: 'requestInterceptor', label: 'Intercept Request' },
  response: {
    enabled: 'interceptResponse',
    code: 'responseInterceptor',
    label: 'Intercept Response',
  },
} as const;

function InterceptorEditor({ kind }: { kind: keyof typeof FIELDS }): React.JSX.Element | null {
  const field = FIELDS[kind];
  const settings = useProxyStore((s) => s.settings);
  const running = useProxyStore((s) => s.running);
  const updateSettings = useProxyStore((s) => s.updateSettings);
  const [open, setOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>(null);

  if (!settings) return null;

  const onCodeChange = (value: string): void => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      void updateSettings({ [field.code]: value } as Partial<AppSettings>);
    }, 400);
  };

  return (
    <div className="border-b border-neutral-100 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-1">
        <input
          id={`enable-${kind}`}
          type="checkbox"
          checked={settings[field.enabled]}
          disabled={running}
          onChange={(e) =>
            void updateSettings({ [field.enabled]: e.target.checked } as Partial<AppSettings>)
          }
        />
        <label htmlFor={`enable-${kind}`} className="text-sm text-neutral-700">
          {field.label}
        </label>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          {open ? (
            <ChevronDown className="h-3 w-3" aria-hidden />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden />
          )}
          {open ? 'hide' : 'show'} editor
        </button>
        {running && settings[field.enabled] && (
          <span className="text-xs text-neutral-400">read-only while the proxy runs</span>
        )}
      </div>
      {open && (
        <div className="h-44 border-t border-neutral-100">
          <MonacoView
            value={settings[field.code]}
            language="javascript"
            readOnly={running}
            onChange={running ? undefined : onCodeChange}
          />
        </div>
      )}
    </div>
  );
}

export function InterceptorPanel(): React.JSX.Element {
  return (
    <div className="border-b border-neutral-200 bg-white">
      <InterceptorEditor kind="request" />
      <InterceptorEditor kind="response" />
    </div>
  );
}
