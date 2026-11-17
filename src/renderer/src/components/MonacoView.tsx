// Lazy wrapper: the monaco bundle is large, so it loads on first editor mount
// instead of at app startup. Keep this module monaco-free.
import { lazy, Suspense } from 'react';

const Impl = lazy(() => import('./MonacoViewImpl'));

export function bodyToText(body: Uint8Array | string | undefined): string {
  if (!body) return '';
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

export function MonacoView(props: {
  value: string;
  language: string;
  format?: boolean;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}): React.JSX.Element {
  return (
    <Suspense fallback={<div className="p-3 text-xs text-neutral-400">Loading editor…</div>}>
      <Impl {...props} />
    </Suspense>
  );
}

const DiffImpl = lazy(() => import('./MonacoDiffImpl'));

/** Lazily loaded side-by-side diff editor (read-only). */
export function MonacoDiffView(props: {
  original: string;
  modified: string;
  language: string;
}): React.JSX.Element {
  return (
    <Suspense fallback={<div className="p-3 text-xs text-neutral-400">Loading editor…</div>}>
      <DiffImpl {...props} />
    </Suspense>
  );
}
