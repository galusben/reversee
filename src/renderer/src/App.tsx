import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useProxyStore } from './stores/proxyStore';
import { SettingsBar } from './components/SettingsBar';
import { TrafficTable } from './components/TrafficTable';

export default function App(): React.JSX.Element {
  const init = useProxyStore((s) => s.init);
  const error = useProxyStore((s) => s.error);
  const dismissError = useProxyStore((s) => s.dismissError);
  const running = useProxyStore((s) => s.running);
  const port = useProxyStore((s) => s.port);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="flex h-screen flex-col bg-neutral-100">
      <SettingsBar />
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
      <TrafficTable />
      <div className="border-t border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-500">
        {running ? `Proxy running on port ${port}` : 'Proxy stopped'}
      </div>
    </div>
  );
}
