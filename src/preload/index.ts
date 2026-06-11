import { contextBridge } from 'electron';

// Minimal scaffold; the typed RevAPI surface lands with the new shell.
contextBridge.exposeInMainWorld('reversee', {
  ping: (): string => 'pong',
});
