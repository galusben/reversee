/** Maps a content-type header to a monaco language id. Kept monaco-free so
 * importing it does not pull the lazy editor bundle. */
export function languageForContentType(contentType: string | undefined): string {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mime.endsWith('json') || mime.endsWith('+json')) return 'json';
  if (mime === 'text/html' || mime.endsWith('+html')) return 'html';
  if (mime === 'text/css') return 'css';
  if (mime === 'application/javascript' || mime === 'text/javascript') return 'javascript';
  if (mime.endsWith('xml') || mime.endsWith('+xml')) return 'xml';
  return 'plaintext';
}
