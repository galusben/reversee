import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Trash2, X } from 'lucide-react';
import { useBreakpointStore } from '../stores/breakpointStore';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export function BreakpointsDialog(): React.JSX.Element {
  const open = useBreakpointStore((s) => s.editorOpen);
  const setOpen = useBreakpointStore((s) => s.setEditorOpen);
  const rules = useBreakpointStore((s) => s.rules);
  const compileErrors = useBreakpointStore((s) => s.compileErrors);
  const addRule = useBreakpointStore((s) => s.addRule);
  const removeRule = useBreakpointStore((s) => s.removeRule);

  const [path, setPath] = useState('');
  const [methods, setMethods] = useState<string[]>(['GET']);

  const toggleMethod = (m: string): void => {
    setMethods((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  };

  const add = (): void => {
    if (!path || methods.length === 0) return;
    void addRule(path, methods);
    setPath('');
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[640px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Breakpoints</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-1 hover:bg-neutral-100">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-3 text-sm text-neutral-500">
            Hold matching requests for editing before they are forwarded. Path is a regular
            expression matched against the request URL.
          </Dialog.Description>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            {METHODS.map((m) => (
              <label key={m} className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={methods.includes(m)} onChange={() => toggleMethod(m)} />
                {m}
              </label>
            ))}
          </div>
          <div className="mb-4 flex gap-2">
            <input
              type="text"
              aria-label="URL path regex"
              placeholder="URL path regex, e.g. /api/.*"
              className="grow rounded-md border border-neutral-300 px-2 py-1 text-sm"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <button
              type="button"
              onClick={add}
              disabled={!path || methods.length === 0}
              className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-neutral-300"
            >
              Add
            </button>
          </div>

          {compileErrors.length > 0 && (
            <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {compileErrors.map((e) => (
                <div key={e.id}>
                  Invalid pattern “{e.path}”: {e.error}
                </div>
              ))}
            </div>
          )}

          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-1">Path</th>
                <th className="py-1">Methods</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-t border-neutral-100">
                  <td className="py-1.5 font-mono text-xs">{rule.path}</td>
                  <td className="py-1.5 text-xs">{rule.methods.join(', ')}</td>
                  <td className="py-1.5">
                    <button
                      type="button"
                      aria-label={`Delete breakpoint ${rule.path}`}
                      onClick={() => void removeRule(rule.id)}
                      className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rules.length === 0 && (
            <div className="py-3 text-center text-xs text-neutral-400">No breakpoints defined.</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
