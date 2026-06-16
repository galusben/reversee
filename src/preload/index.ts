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
  getTraffic: () => ipcRenderer.invoke(IPC.trafficGetAll),
  clearTraffic: () => ipcRenderer.invoke(IPC.trafficClear),
  copyToClipboard: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text),
  getBreakpoints: () => ipcRenderer.invoke(IPC.breakpointsGet),
  setBreakpoints: (rules) => ipcRenderer.invoke(IPC.breakpointsSet, rules),
  resumeBreakpoint: (id, params) => ipcRenderer.invoke(IPC.breakpointResume, id, params),
  getProtoSpecs: () => ipcRenderer.invoke(IPC.protoSpecsGet),
  importProtoSpec: () => ipcRenderer.invoke(IPC.protoSpecsImport),
  removeProtoSpec: (id) => ipcRenderer.invoke(IPC.protoSpecsRemove, id),
  onTraffic: subscribe(IPC.trafficEvent),
  onTrafficCleared: subscribe(IPC.trafficClearedEvent),
  onBreakpointHit: subscribe(IPC.breakpointHitEvent),
  onBreakpointErrors: subscribe(IPC.breakpointErrorsEvent),
  onOpenBreakpoints: subscribe(IPC.openBreakpointsEvent),
  onOpenConnectAi: subscribe(IPC.openConnectAiEvent),
  onOpenProtoSpecs: subscribe(IPC.openProtoSpecsEvent),
  onProxyState: subscribe(IPC.proxyStateEvent),
  onProxyError: subscribe(IPC.proxyErrorEvent),
  onSettingsChanged: subscribe(IPC.settingsChangedEvent),
};

contextBridge.exposeInMainWorld('reversee', api);
