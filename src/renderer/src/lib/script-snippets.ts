// The reference list and ready-made examples shown beside the script editors.
import type { ScriptKind } from '../../../shared/types';

export interface ScriptSnippet {
  label: string;
  code: string;
}

export interface ScriptField {
  name: string;
  hint: string;
}

export const SCRIPT_FIELDS: Record<ScriptKind, ScriptField[]> = {
  request: [
    { name: 'requestParams.method', hint: 'GET, POST…' },
    { name: 'requestParams.path', hint: 'path and query string' },
    { name: 'requestParams.host', hint: 'server the request goes to' },
    { name: 'requestParams.port', hint: 'its port' },
    { name: 'requestParams.headers', hint: 'object, lower-case names' },
    { name: 'requestParams.body', hint: 'bytes; use .toString() for text' },
  ],
  response: [
    { name: 'responseParams.statusCode', hint: '200, 404…' },
    { name: 'responseParams.headers', hint: 'object, lower-case names' },
    { name: 'responseParams.body', hint: 'bytes; use .toString() for text' },
    { name: 'requestParams', hint: 'the request, read-only here' },
  ],
};

export const SCRIPT_SNIPPETS: Record<ScriptKind, ScriptSnippet[]> = {
  request: [
    { label: 'Add a header', code: "requestParams.headers['x-debug'] = 'true';" },
    { label: 'Remove a header', code: "delete requestParams.headers['cookie'];" },
    {
      label: 'Rewrite the path',
      code: "requestParams.path = requestParams.path.replace('/v1/', '/v2/');",
    },
    {
      label: 'Change a JSON field',
      code:
        'const data = JSON.parse(requestParams.body.toString());\n' +
        'data.debug = true;\n' +
        'requestParams.body = JSON.stringify(data);',
    },
    {
      label: 'Only some requests',
      code:
        "if (requestParams.path.startsWith('/api/')) {\n" +
        "  requestParams.headers['x-debug'] = 'true';\n" +
        '}',
    },
    { label: 'Log it', code: 'console.log(requestParams.method, requestParams.path);' },
  ],
  response: [
    { label: 'Change the status', code: 'responseParams.statusCode = 503;' },
    {
      label: 'Add a header',
      code: "responseParams.headers['access-control-allow-origin'] = '*';",
    },
    {
      label: 'Change a JSON field',
      code:
        'const data = JSON.parse(responseParams.body.toString());\n' +
        'data.beta = true;\n' +
        'responseParams.body = JSON.stringify(data);',
    },
    { label: 'Replace the body', code: 'responseParams.body = JSON.stringify({ ok: true });' },
    {
      label: 'Only some requests',
      code:
        "if (requestParams.path.startsWith('/api/')) {\n" +
        '  responseParams.statusCode = 500;\n' +
        '}',
    },
    {
      label: 'Log it',
      code: 'console.log(responseParams.statusCode, requestParams.path);',
    },
  ],
};

/** Adds an example under whatever is already written. */
export function appendSnippet(code: string, snippet: string): string {
  const trimmed = code.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${snippet}\n` : `${snippet}\n`;
}
