import { useEffect, useRef } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import '../lib/monaco-setup';
import { useDarkMode } from '../lib/theme';

type DiffModels = ReturnType<Parameters<DiffOnMount>[0]['getModel']>;

/** Read-only side-by-side Monaco diff (A on the left, B on the right). */
export default function MonacoDiffImpl({
  original,
  modified,
  language,
}: {
  original: string;
  modified: string;
  language: string;
}): React.JSX.Element {
  const dark = useDarkMode();
  const models = useRef<DiffModels>(null);
  // @monaco-editor/react disposes the text models before the diff widget on
  // unmount, which Monaco reports as an uncaught "TextModel got disposed
  // before DiffEditorWidget model got reset". Keep the models (the keepCurrent*
  // props) and dispose them once the widget itself is gone.
  useEffect(
    () => () => {
      const current = models.current;
      setTimeout(() => {
        current?.original.dispose();
        current?.modified.dispose();
      }, 0);
    },
    []
  );
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={language}
      theme={dark ? 'vs-dark' : 'light'}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        models.current = editor.getModel();
      }}
      options={{
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        contextmenu: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderSideBySide: true,
        wordWrap: 'on',
      }}
    />
  );
}
