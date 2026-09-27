import Editor, { type OnMount } from '@monaco-editor/react';
import '../lib/monaco-setup';

type Editor = Parameters<OnMount>[0];

const FORMATTER_WAIT_MS = 5_000;
const FORMATTER_POLL_MS = 50;

/** Formats a read-only editor's document once a formatter is available.
 * Monaco loads a language mode (which registers its formatter) lazily, the
 * first time a model of that language exists, so on the first mount in a
 * session the provider is not there yet (#31). Wait for the action's
 * precondition instead of running it straight away; give up after a few
 * seconds for languages with no formatter (plaintext, xml). */
async function formatOnce(editor: Editor): Promise<void> {
  let disposed = false;
  const sub = editor.onDidDispose(() => (disposed = true));
  // Same trick as the 1.x UI: the format action only runs on writable
  // editors, so flip readOnly around it.
  editor.updateOptions({ readOnly: false });
  try {
    const action = editor.getAction('editor.action.formatDocument');
    const deadline = Date.now() + FORMATTER_WAIT_MS;
    while (action && !action.isSupported() && !disposed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, FORMATTER_POLL_MS));
    }
    if (action?.isSupported() && !disposed) await action.run();
  } finally {
    sub.dispose();
    if (!disposed) editor.updateOptions({ readOnly: true });
  }
}

/** Monaco view: read-only display by default, editable when onChange is set.
 * `format` runs the document formatter on mount (read-only displays only). */
export default function MonacoViewImpl({
  value,
  language,
  format = false,
  readOnly = true,
  onChange,
}: {
  value: string;
  language: string;
  format?: boolean;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}): React.JSX.Element {
  const onMount: OnMount = (editor) => {
    if (format && readOnly) void formatOnce(editor);
  };

  return (
    <Editor
      value={value}
      language={language}
      onMount={onMount}
      onChange={onChange ? (v) => onChange(v ?? '') : undefined}
      options={{
        readOnly,
        automaticLayout: true,
        contextmenu: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
      }}
    />
  );
}
