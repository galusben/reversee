import Editor, { type OnMount } from '@monaco-editor/react';
import '../lib/monaco-setup';

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
    if (format && readOnly) {
      // Same trick as the 1.x UI: the format action only runs on writable
      // editors, so flip readOnly around it.
      editor.updateOptions({ readOnly: false });
      void editor
        .getAction('editor.action.formatDocument')
        ?.run()
        .then(() => editor.updateOptions({ readOnly: true }));
    }
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
