import { useState } from 'react';
import {
  ArrowRight,
  FileCode,
  OctagonPause,
  Play,
  Settings,
  Sparkles,
  Split,
  Square,
} from 'lucide-react';
import { lastScriptError } from './ScriptsDialog';
import { CaptureHowTo } from './CaptureHowTo';
import { useProxyStore } from '../stores/proxyStore';
import { useBreakpointStore } from '../stores/breakpointStore';
import { useUiStore } from '../stores/uiStore';
import { isValidPort, type AppSettings } from '../../../shared/settings-schema';
import type { Protocol } from '../../../shared/types';

function PortInput({
  value,
  disabled,
  label,
  onCommit,
  onValidity,
}: {
  value: number;
  disabled: boolean;
  label: string;
  onCommit: (port: number) => void;
  onValidity: (valid: boolean) => void;
}): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const parsed = Number(text);
  const valid = isValidPort(parsed);

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      aria-invalid={!valid}
      title={valid ? label : `${label}: must be an integer between 1 and 65535`}
      className={`w-20 rounded-md border px-2 py-1 text-sm ${
        valid ? 'border-neutral-300' : 'border-red-500 bg-red-50'
      } disabled:bg-neutral-100 disabled:text-neutral-400`}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        const port = Number(e.target.value);
        const ok = isValidPort(port);
        onValidity(ok);
        if (ok) onCommit(port);
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
  const openConnectAi = useUiStore((s) => s.setConnectAiOpen);
  const openRules = useUiStore((s) => s.setRulesOpen);
  const openScripts = useUiStore((s) => s.setScriptsOpen);
  const openPreferences = useUiStore((s) => s.setPreferencesOpen);
  // A script that failed on the latest request is flagged on the button itself.
  const scriptError = useProxyStore((s) => {
    const on = s.settings;
    if (!on) return null;
    return (
      (on.interceptRequest ? lastScriptError(s.traffic, 'request') : null) ??
      (on.interceptResponse ? lastScriptError(s.traffic, 'response') : null)
    );
  });

  const [invalidPorts, setInvalidPorts] = useState({ listen: false, dest: false });
  const [howToOpen, setHowToOpen] = useState(false);

  if (!settings) return null;

  const set = (patch: Partial<AppSettings>): void => void updateSettings(patch);
  const activeRules =
    settings.routes.filter((r) => r.enabled).length +
    settings.mocks.filter((m) => m.enabled).length;
  const activeScripts = Number(settings.interceptRequest) + Number(settings.interceptResponse);
  const capture = settings.captureAll;
  const startDisabled =
    invalidPorts.listen ||
    !isValidPort(settings.listenPort) ||
    (!capture && (!settings.dest || invalidPorts.dest || !isValidPort(settings.destPort)));
  const proxyAddress = `http://localhost:${settings.listenPort}`;

  return (
    // Two groups that share a row when the window is wide enough; otherwise the
    // actions wrap under the connection settings instead of being clipped.
    <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-white px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <select
          aria-label="Mode"
          title="Forward to one server: a reverse proxy in front of one destination. Capture anything: an HTTP/HTTPS proxy that records whatever the client talks to."
          className="shrink-0 rounded-md border border-neutral-300 px-1 py-1 text-sm font-medium text-neutral-700 disabled:bg-neutral-100 disabled:text-neutral-400"
          value={capture ? 'capture' : 'forward'}
          disabled={running}
          onChange={(e) => set({ captureAll: e.target.value === 'capture' })}
        >
          <option value="forward">Forward to one server</option>
          <option value="capture">Capture anything</option>
        </select>
        <span className="shrink-0 text-sm font-medium text-neutral-600">
          {capture ? 'Proxy port' : 'Listen'}
        </span>
        {!capture && (
          <ProtocolSelect
            label="Listen protocol"
            value={settings.listenProtocol}
            disabled={running}
            onChange={(p) => set({ listenProtocol: p })}
          />
        )}
        <PortInput
          label="Listen port"
          value={settings.listenPort}
          disabled={running}
          onCommit={(port) => set({ listenPort: port })}
          onValidity={(valid) => setInvalidPorts((p) => ({ ...p, listen: !valid }))}
        />
        {capture ? (
          <>
            <code
              className="min-w-0 truncate rounded bg-neutral-100 px-1.5 py-1 text-xs text-neutral-700"
              title="Set this as the HTTP and HTTPS proxy of the client you want to inspect"
            >
              {proxyAddress}
            </code>
            <button
              type="button"
              onClick={() => setHowToOpen(true)}
              className="shrink-0 whitespace-nowrap rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-50"
            >
              How to connect
            </button>
          </>
        ) : (
          <>
            <ArrowRight className="h-4 w-4 text-neutral-400" aria-hidden />
            <span className="shrink-0 text-sm font-medium text-neutral-600">Destination</span>
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
              className="w-44 min-w-24 shrink rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:bg-neutral-100 disabled:text-neutral-400"
              value={settings.dest}
              disabled={running}
              onChange={(e) => set({ dest: e.target.value.trim() })}
            />
            <PortInput
              label="Destination port"
              value={settings.destPort}
              disabled={running}
              onCommit={(port) => set({ destPort: port })}
              onValidity={(valid) => setInvalidPorts((p) => ({ ...p, dest: !valid }))}
            />
            <label
              className="flex shrink-0 items-center gap-1.5 text-sm text-neutral-600"
              title="Run an HTTP/2 listener to proxy and decode gRPC. Import .proto/.desc under the gRPC menu."
            >
              <input
                type="checkbox"
                checked={settings.enableGrpc}
                disabled={running}
                onChange={(e) => set({ enableGrpc: e.target.checked })}
              />
              gRPC
            </label>
          </>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => openConnectAi(true)}
          title="Connect an AI agent (MCP)"
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-2.5 py-1.5 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Connect AI
        </button>
        <button
          type="button"
          onClick={() => openRules(true)}
          title="Routes and mocks: answer requests with a response you write, or send some to a different server (Cmd/Ctrl+Shift+M)"
          aria-label={`Routes and mocks${activeRules > 0 ? `, ${activeRules} active` : ''}`}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
        >
          <Split className="h-3.5 w-3.5" aria-hidden />
          Routes &amp; Mocks
          {activeRules > 0 && (
            <span className="rounded-full bg-blue-600 px-1.5 text-xs font-medium leading-5 text-white">
              {activeRules}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => openScripts(true)}
          title={
            scriptError
              ? `A script failed on the last request: ${scriptError}`
              : 'Scripts: change requests and responses with a few lines of JavaScript (Cmd/Ctrl+Shift+J)'
          }
          aria-label={`Scripts${activeScripts > 0 ? `, ${activeScripts} on` : ''}${scriptError ? ', last run failed' : ''}`}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
        >
          <FileCode className="h-3.5 w-3.5" aria-hidden />
          Scripts
          {activeScripts > 0 && (
            <span
              className={`rounded-full px-1.5 text-xs font-medium leading-5 text-white ${
                scriptError ? 'bg-red-600' : 'bg-blue-600'
              }`}
            >
              {scriptError ? '!' : activeScripts}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => openBreakpoints(true)}
          title="Edit breakpoints (Cmd/Ctrl+B)"
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
        >
          <OctagonPause className="h-3.5 w-3.5" aria-hidden />
          Breakpoints{ruleCount > 0 ? ` (${ruleCount})` : ''}
        </button>
        <button
          type="button"
          onClick={() => openPreferences(true)}
          title="Preferences"
          aria-label="Preferences"
          className="shrink-0 rounded-md border border-neutral-300 p-2 text-neutral-600 hover:bg-neutral-50"
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
        </button>
        {running ? (
          <button
            type="button"
            onClick={() => void stop()}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            <Square className="h-3.5 w-3.5" aria-hidden /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={startDisabled}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            <Play className="h-3.5 w-3.5" aria-hidden /> Start
          </button>
        )}
      </div>
      {howToOpen && <CaptureHowTo address={proxyAddress} onClose={() => setHowToOpen(false)} />}
    </div>
  );
}
