import { useProxyStore } from '../stores/proxyStore';
import type { TrafficEntry } from '../../../shared/types';

function statusClass(entry: TrafficEntry): string {
  const code = entry.response.statusCode ?? 0;
  if (code >= 500) return 'text-red-600';
  if (code >= 400) return 'text-amber-600';
  if (code >= 300) return 'text-blue-600';
  return 'text-emerald-700';
}

function contentType(entry: TrafficEntry): string {
  const value = entry.response.headers['content-type'];
  const text = Array.isArray(value) ? value[0] : value;
  return text ? text.split(';')[0] : '';
}

export function TrafficTable(): React.JSX.Element {
  const traffic = useProxyStore((s) => s.traffic);
  const selectedId = useProxyStore((s) => s.selectedId);
  const select = useProxyStore((s) => s.select);

  return (
    <div className="min-h-0 grow overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="w-12 px-3 py-2">#</th>
            <th className="w-20 px-3 py-2">Method</th>
            <th className="px-3 py-2">Path</th>
            <th className="w-20 px-3 py-2">Status</th>
            <th className="w-48 px-3 py-2">Content-Type</th>
          </tr>
        </thead>
        <tbody>
          {traffic.map((entry) => (
            <tr
              key={entry.trafficId}
              onClick={() => select(entry.trafficId)}
              className={`cursor-pointer border-b border-neutral-100 hover:bg-neutral-50 ${
                selectedId === entry.trafficId ? 'bg-blue-50' : ''
              }`}
            >
              <td className="px-3 py-1.5 text-neutral-400">{entry.trafficId}</td>
              <td className="px-3 py-1.5 font-medium">{entry.request.method}</td>
              <td className="max-w-0 truncate px-3 py-1.5" title={entry.request.url}>
                {entry.request.url}
              </td>
              <td className={`px-3 py-1.5 font-medium ${statusClass(entry)}`}>
                {entry.connectorError ? 'ERR' : (entry.response.statusCode ?? '')}
              </td>
              <td className="truncate px-3 py-1.5 text-neutral-500">{contentType(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {traffic.length === 0 && (
        <div className="p-8 text-center text-sm text-neutral-400">
          No traffic yet. Start the proxy and send requests to the listen port.
        </div>
      )}
    </div>
  );
}
