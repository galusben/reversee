/// <reference types="vite/client" />
import type { RevAPI } from '../../shared/ipc';

declare global {
  interface Window {
    reversee: RevAPI;
  }
}

export {};
