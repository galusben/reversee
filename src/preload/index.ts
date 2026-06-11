// The only bridge between the sandboxed renderer and main. Exposes the typed
// RevAPI (shared/ipc.ts); raw ipcRenderer is never exposed and every channel
// is allowlisted here.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type RevAPI } from '../shared/ipc';

function subscribe<T>(channel: string): (cb: (data: T) => void) => () => void {
  return (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, data: T): void => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

const api: RevAPI = {
  startProxy: () => ipcRenderer.invoke(IPC.proxyStart),
  stopProxy: () => ipcRenderer.invoke(IPC.proxyStop),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  migrateLegacySettings: (old) => ipcRenderer.invoke(IPC.settingsMigrateLegacy, old),
  getVersion: () => ipcRenderer.invoke(IPC.appVersion),
  onTraffic: subscribe(IPC.trafficEvent),
  onProxyState: subscribe(IPC.proxyStateEvent),
  onProxyError: subscribe(IPC.proxyErrorEvent),
  onSettingsChanged: subscribe(IPC.settingsChangedEvent),
};

contextBridge.exposeInMainWorld('reversee', api);
