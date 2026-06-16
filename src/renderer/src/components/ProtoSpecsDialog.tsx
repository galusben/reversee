import * as Dialog from '@radix-ui/react-dialog';
import { FilePlus2, Trash2, X } from 'lucide-react';
import { useProtoSpecStore } from '../stores/protoSpecStore';

export function ProtoSpecsDialog(): React.JSX.Element {
  const open = useProtoSpecStore((s) => s.editorOpen);
  const setOpen = useProtoSpecStore((s) => s.setEditorOpen);
  const specs = useProtoSpecStore((s) => s.specs);
  const compileErrors = useProtoSpecStore((s) => s.compileErrors);
  const importing = useProtoSpecStore((s) => s.importing);
  const importSpec = useProtoSpecStore((s) => s.importSpec);
  const removeSpec = useProtoSpecStore((s) => s.removeSpec);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[640px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Proto Specs</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-1 hover:bg-neutral-100">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-3 text-sm text-neutral-500">
            Protobuf definitions used to decode gRPC traffic into readable JSON, matched by gRPC
            method (<code className="font-mono">/package.Service/Method</code>). Import a{' '}
            <code className="font-mono">.proto</code> file or a compiled{' '}
            <code className="font-mono">.desc</code> FileDescriptorSet.
          </Dialog.Description>

          <div className="mb-4 flex gap-2">
            <button
              type="button"
              onClick={() => void importSpec()}
              disabled={importing}
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-neutral-300"
            >
              <FilePlus2 className="h-4 w-4" aria-hidden />
              {importing ? 'Importing…' : 'Import .proto / .desc'}
            </button>
          </div>

          {compileErrors.length > 0 && (
            <div
              role="alert"
              className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700"
            >
              {compileErrors.map((e) => (
                <div key={e.id}>
                  Failed to compile “{e.name}”: {e.error}
                </div>
              ))}
            </div>
          )}

          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-1">Name</th>
                <th className="py-1">Source</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {specs.map((spec) => (
                <tr key={spec.id} className="border-t border-neutral-100">
                  <td className="py-1.5 font-mono text-xs">{spec.name}</td>
                  <td className="py-1.5 text-xs">
                    {spec.source === 'descriptor' ? 'descriptor (.desc)' : 'proto (.proto)'}
                  </td>
                  <td className="py-1.5">
                    <button
                      type="button"
                      aria-label={`Delete proto spec ${spec.name}`}
                      onClick={() => void removeSpec(spec.id)}
                      className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {specs.length === 0 && (
            <div className="py-3 text-center text-xs text-neutral-400">No proto specs imported.</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
