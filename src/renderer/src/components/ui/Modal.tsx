// Shared frame for the app's dialogs: overlay, centered panel, title + close.
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  width = 'w-[720px]',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  width?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 max-h-[88vh] ${width} max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg bg-white p-5 shadow-xl`}
        >
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-1 hover:bg-neutral-100">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm text-neutral-500">
            {description ?? title}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const inputClass =
  'rounded-md border border-neutral-300 px-2 py-1 text-sm disabled:bg-neutral-100 disabled:text-neutral-400';
export const primaryButton =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-300';
export const secondaryButton =
  'rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 disabled:text-neutral-400';
