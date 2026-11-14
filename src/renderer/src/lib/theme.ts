import { useEffect, useState } from 'react';

const QUERY = '(prefers-color-scheme: dark)';

/**
 * Whether the app is currently dark. The CSS follows prefers-color-scheme on
 * its own (main pins it via nativeTheme when the user forces a theme); this
 * hook is for the few things CSS cannot restyle, like the Monaco theme.
 */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    const onChange = (): void => setDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return dark;
}
