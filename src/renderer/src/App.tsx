import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useProxyStore } from './stores/proxyStore';
import { useBreakpointStore } from './stores/breakpointStore';
import { SettingsBar } from './components/SettingsBar';
import { TrafficTable } from './components/TrafficTable';
import { DetailPanes } from './components/DetailPanes';
import { BreakpointsDialog } from './components/BreakpointsDialog';
import { BreakpointQueue } from './components/BreakpointQueue';
import { ConnectAiDialog } from './components/ConnectAiDialog';
import { ProtoSpecsDialog } from './components/ProtoSpecsDialog';
import { useProtoSpecStore } from './stores/protoSpecStore';
import { SummaryDialog } from './components/SummaryDialog';
import { useUiStore } from './stores/uiStore';
import { PreferencesDialog } from './components/PreferencesDialog';
import { RulesDialog } from './components/RulesDialog';
import { ScriptsDialog } from './components/ScriptsDialog';
import { ReplayDialog } from './components/ReplayDialog';

export default function App(): React.JSX.Element {
  const init = useProxyStore((s) => s.init);
  const initBreakpoints = useBreakpointStore((s) => s.init);
  const initProtoSpecs = useProtoSpecStore((s) => s.init);
  const error = useProxyStore((s) => s.error);
  const dismissError = useProxyStore((s) => s.dismissError);
  const running = useProxyStore((s) => s.running);
  const port = useProxyStore((s) => s.port);
  const openConnectAi = useUiStore((s) => s.setConnectAiOpen);
  const notice = useUiStore((s) => s.notice);
  const clearNotice = useUiStore((s) => s.clearNotice);
  const certStatus = useProxyStore((s) => s.certStatus);
  // Both an HTTPS listener and capture-anything mode present certificates signed by the root.
  const listensHttps = useProxyStore(
    (s) => s.settings?.listenProtocol === 'https' || s.settings?.captureAll === true
  );
  const regenerateRootCert = useProxyStore((s) => s.regenerateRootCert);
  const pendingCount = useProxyStore((s) => s.traffic.filter((e) => e.pending).length);
  const trafficCount = useProxyStore((s) => s.traffic.length);

  useEffect(() => {
    void init();
    void initBreakpoints();
    void initProtoSpecs();
    const ui = useUiStore.getState();
    // Menu items drive the same state as the on-screen controls.
    const unsubscribe = [
      window.reversee.onOpenConnectAi(() => openConnectAi(true)),
      window.reversee.onOpenPreferences(() => ui.setPreferencesOpen(true)),
      window.reversee.onOpenRules(() => ui.setRulesOpen(true)),
      window.reversee.onOpenScripts(() => ui.setScriptsOpen(true)),
      window.reversee.onFocusFilter(() => ui.requestFilterFocus()),
      window.reversee.onToggleProxy(() => {
        const proxy = useProxyStore.getState();
        if (proxy.running) void proxy.stop();
        else if (proxy.settings?.dest || proxy.settings?.captureAll) void proxy.start();
      }),
    ];
    return () => unsubscribe.forEach((off) => off());
  }, [init, initBreakpoints, initProtoSpecs, openConnectAi]);

  // Only worth interrupting for when HTTPS clients are (about to be) affected.
  const certProblem =
    certStatus && listensHttps && (certStatus.expiringSoon || certStatus.temporary)
      ? certStatus.temporary
        ? `The saved root certificate could not be unlocked (${certStatus.temporaryReason}); a temporary one is in use, so HTTPS clients will not trust the proxy.`
        : certStatus.expired
          ? `The root certificate expired on ${certStatus.notAfter.slice(0, 10)}. HTTPS clients will reject the proxy until you regenerate and trust a new one.`
          : `The root certificate expires in ${certStatus.daysLeft} day${certStatus.daysLeft === 1 ? '' : 's'}.`
      : null;

  return (
    <div className="flex h-screen flex-col bg-neutral-100">
      <SettingsBar />
      <BreakpointQueue />
      <BreakpointsDialog />
      <ProtoSpecsDialog />
      <ConnectAiDialog />
      <SummaryDialog />
      <PreferencesDialog />
      <RulesDialog />
      <ScriptsDialog />
      <ReplayDialog />
      {certProblem && (
        <div
          role="alert"
          aria-label="Root certificate warning"
          className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <span>{certProblem}</span>
          <button
            type="button"
            onClick={() => void regenerateRootCert()}
            className="shrink-0 rounded border border-amber-300 px-2 py-0.5 text-xs font-medium hover:bg-amber-100"
          >
            Regenerate…
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between border-b border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <span>
            {error.code ? `${error.code}: ` : ''}
            {error.message}
          </span>
          <button type="button" aria-label="Dismiss error" onClick={dismissError}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}
      <Group orientation="vertical" className="min-h-0 grow">
        <Panel defaultSize="50%" minSize="15%" className="flex flex-col">
          <TrafficTable />
        </Panel>
        <Separator className="h-1.5 bg-neutral-200 transition-colors hover:bg-blue-300 data-[separator-state=drag]:bg-blue-400" />
        <Panel defaultSize="50%" minSize="20%">
          <DetailPanes />
        </Panel>
      </Group>
      <div className="flex items-center gap-4 border-t border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-500">
        <span>{running ? `Proxy running on port ${port}` : 'Proxy stopped'}</span>
        <span aria-label="Request count">
          {trafficCount} request{trafficCount === 1 ? '' : 's'}
          {pendingCount > 0 ? `, ${pendingCount} in flight` : ''}
        </span>
        <div className="grow" />
        {notice && (
          <button
            type="button"
            role="status"
            onClick={clearNotice}
            title="Dismiss"
            className={`max-w-[60%] truncate ${notice.kind === 'error' ? 'text-red-600' : 'text-emerald-700'}`}
          >
            {notice.text}
          </button>
        )}
      </div>
    </div>
  );
}
