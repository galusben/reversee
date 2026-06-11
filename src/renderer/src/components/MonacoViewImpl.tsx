import Editor, { type OnMount } from '@monaco-editor/react';
import '../lib/monaco-setup';

/** Read-only monaco view; optionally runs the document formatter on mount. */
export default function MonacoViewImpl({
  value,
  language,
  format = false,
}: {
  value: string;
  language: string;
  format?: boolean;
}): React.JSX.Element {
  const onMount: OnMount = (editor) => {
    if (format) {
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
      options={{
        readOnly: true,
        automaticLayout: true,
        contextmenu: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
      }}
    />
  );
}
