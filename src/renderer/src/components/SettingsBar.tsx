import { useState } from 'react';
import { ArrowRight, OctagonPause, Play, Square } from 'lucide-react';
import { useProxyStore } from '../stores/proxyStore';
import { useBreakpointStore } from '../stores/breakpointStore';
import { isValidPort, type AppSettings } from '../../../shared/settings-schema';
import type { Protocol } from '../../../shared/types';

function PortInput({
  value,
  disabled,
  label,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  label: string;
  onCommit: (port: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const parsed = Number(text);
  const valid = isValidPort(parsed);

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      title={valid ? label : `${label}: must be an integer between 1 and 65535`}
      className={`w-20 rounded-md border px-2 py-1 text-sm ${
        valid ? 'border-neutral-300' : 'border-red-500 bg-red-50'
      } disabled:bg-neutral-100 disabled:text-neutral-400`}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        const port = Number(e.target.value);
        if (isValidPort(port)) onCommit(port);
      }}
    />
  );
}

function ProtocolSelect({
  value,
  disabled,
  label,
  onChange,
}: {
  value: Protocol;
  disabled: boolean;
  label: string;
  onChange: (p: Protocol) => void;
}): React.JSX.Element {
  return (
    <select
      aria-label={label}
      className="rounded-md border border-neutral-300 px-1 py-1 text-sm disabled:bg-neutral-100 disabled:text-neutral-400"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Protocol)}
    >
      <option value="http">http</option>
      <option value="https">https</option>
    </select>
  );
}

export function SettingsBar(): React.JSX.Element | null {
  const settings = useProxyStore((s) => s.settings);
  const running = useProxyStore((s) => s.running);
  const updateSettings = useProxyStore((s) => s.updateSettings);
  const start = useProxyStore((s) => s.start);
  const stop = useProxyStore((s) => s.stop);
  const openBreakpoints = useBreakpointStore((s) => s.setEditorOpen);
  const ruleCount = useBreakpointStore((s) => s.rules.length);

  if (!settings) return null;

  const set = (patch: Partial<AppSettings>): void => void updateSettings(patch);
  const startDisabled =
    !settings.dest || !isValidPort(settings.listenPort) || !isValidPort(settings.destPort);

  return (
    <div className="flex items-center gap-2 border-b border-neutral-200 bg-white px-3 py-2">
      <span className="text-sm font-medium text-neutral-600">Listen</span>
      <ProtocolSelect
        label="Listen protocol"
        value={settings.listenProtocol}
        disabled={running}
        onChange={(p) => set({ listenProtocol: p })}
      />
      <PortInput
        label="Listen port"
        value={settings.listenPort}
        disabled={running}
        onCommit={(port) => set({ listenPort: port })}
      />
      <ArrowRight className="h-4 w-4 text-neutral-400" aria-hidden />
      <span className="text-sm font-medium text-neutral-600">Destination</span>
      <ProtocolSelect
        label="Destination protocol"
        value={settings.destProtocol}
        disabled={running}
        onChange={(p) => set({ destProtocol: p })}
      />
      <input
        type="text"
        aria-label="Destination host"
        placeholder="host, e.g. example.com"
        className="w-56 rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:bg-neutral-100 disabled:text-neutral-400"
        value={settings.dest}
        disabled={running}
        onChange={(e) => set({ dest: e.target.value.trim() })}
      />
      <PortInput
        label="Destination port"
        value={settings.destPort}
        disabled={running}
        onCommit={(port) => set({ destPort: port })}
      />
      <div className="grow" />
      <button
        type="button"
        onClick={() => openBreakpoints(true)}
        title="Edit breakpoints (Cmd/Ctrl+B)"
        className="flex items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
      >
        <OctagonPause className="h-3.5 w-3.5" aria-hidden />
        Breakpoints{ruleCount > 0 ? ` (${ruleCount})` : ''}
      </button>
      {running ? (
        <button
          type="button"
          onClick={() => void stop()}
          className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
        >
          <Square className="h-3.5 w-3.5" aria-hidden /> Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={startDisabled}
          className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          <Play className="h-3.5 w-3.5" aria-hidden /> Start
        </button>
      )}
    </div>
  );
}
