// Thin Tailwind-styled wrapper around the Radix context menu primitive.
import * as RadixContextMenu from '@radix-ui/react-context-menu';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
}

export function WithContextMenu({
  items,
  children,
  asChild = true,
}: {
  items: ContextMenuItem[];
  children: React.ReactNode;
  asChild?: boolean;
}): React.JSX.Element {
  return (
    <RadixContextMenu.Root>
      <RadixContextMenu.Trigger asChild={asChild}>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content className="z-50 min-w-44 rounded-md border border-neutral-200 bg-white p-1 shadow-lg">
          {items.map((item) => (
            <RadixContextMenu.Item
              key={item.label}
              onSelect={item.onSelect}
              className="cursor-default rounded px-2 py-1.5 text-sm text-neutral-700 outline-none data-highlighted:bg-neutral-100"
            >
              {item.label}
            </RadixContextMenu.Item>
          ))}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
