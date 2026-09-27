// Configures @monaco-editor/react against the BUNDLED monaco-editor package.
// Without this it loads monaco from a CDN at runtime, which breaks offline
// use and violates the CSP. Worker paths go through monaco-editor's exports map
// (`monaco-editor/*` -> esm/vs/*.js, since 0.56).
// NOTE: this module is only ever loaded via dynamic import (lazy MonacoView)
// so the monaco bundle is not parsed at app startup.
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import cssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import htmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import { loader } from '@monaco-editor/react';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });
