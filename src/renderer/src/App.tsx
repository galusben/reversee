import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useProxyStore } from './stores/proxyStore';
import { useBreakpointStore } from './stores/breakpointStore';
import { SettingsBar } from './components/SettingsBar';
import { InterceptorPanel } from './components/InterceptorPanel';
import { TrafficTable } from './components/TrafficTable';
import { DetailPanes } from './components/DetailPanes';
import { BreakpointsDialog } from './components/BreakpointsDialog';
import { BreakpointQueue } from './components/BreakpointQueue';
import { ConnectAiDialog } from './components/ConnectAiDialog';
import { useUiStore } from './stores/uiStore';

export default function App(): React.JSX.Element {
  const init = useProxyStore((s) => s.init);
  const initBreakpoints = useBreakpointStore((s) => s.init);
  const error = useProxyStore((s) => s.error);
  const dismissError = useProxyStore((s) => s.dismissError);
  const running = useProxyStore((s) => s.running);
  const port = useProxyStore((s) => s.port);
  const openConnectAi = useUiStore((s) => s.setConnectAiOpen);

  useEffect(() => {
    void init();
    void initBreakpoints();
    // The Help > Set Up MCP menu item opens the same dialog as the button.
    return window.reversee.onOpenConnectAi(() => openConnectAi(true));
  }, [init, initBreakpoints, openConnectAi]);

  return (
    <div className="flex h-screen flex-col bg-neutral-100">
      <SettingsBar />
      <InterceptorPanel />
      <BreakpointQueue />
      <BreakpointsDialog />
      <ConnectAiDialog />
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
      <div className="border-t border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-500">
        {running ? `Proxy running on port ${port}` : 'Proxy stopped'}
      </div>
    </div>
  );
}
