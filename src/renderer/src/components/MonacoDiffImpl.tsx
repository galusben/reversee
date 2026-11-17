import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import '../lib/monaco-setup';
import { useDarkMode } from '../lib/theme';

/**
 * Read-only side-by-side Monaco diff (A on the left, B on the right).
 *
 * Drives monaco.editor.createDiffEditor directly rather than through
 * @monaco-editor/react's DiffEditor: that wrapper's unmount disposes the text
 * models and the widget in an order Monaco rejects ("TextModel got disposed
 * before DiffEditorWidget model got reset", "AbstractContextKeyService has been
 * disposed"). Here teardown is explicit: detach the models, dispose the widget,
 * then dispose the models.
 */
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
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const editor = monaco.editor.createDiffEditor(el, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      contextmenu: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderSideBySide: true,
      wordWrap: 'on',
    });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      const models = editor.getModel();
      editor.setModel(null);
      editor.dispose();
      models?.original.dispose();
      models?.modified.dispose();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const previous = editor.getModel();
    editor.setModel({
      original: monaco.editor.createModel(original, language),
      modified: monaco.editor.createModel(modified, language),
    });
    previous?.original.dispose();
    previous?.modified.dispose();
  }, [original, modified, language]);

  useEffect(() => {
    // Same theme names @monaco-editor/react uses for the other editors.
    monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
  }, [dark]);

  return <div ref={host} className="h-full w-full" />;
}
