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
  getTrafficEntry: (trafficId) => ipcRenderer.invoke(IPC.trafficGet, trafficId),
  clearTraffic: () => ipcRenderer.invoke(IPC.trafficClear),
  copyToClipboard: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text),
  getBreakpoints: () => ipcRenderer.invoke(IPC.breakpointsGet),
  setBreakpoints: (rules) => ipcRenderer.invoke(IPC.breakpointsSet, rules),
  resumeBreakpoint: (id, params) => ipcRenderer.invoke(IPC.breakpointResume, id, params),
  getProtoSpecs: () => ipcRenderer.invoke(IPC.protoSpecsGet),
  importProtoSpec: () => ipcRenderer.invoke(IPC.protoSpecsImport),
  removeProtoSpec: (id) => ipcRenderer.invoke(IPC.protoSpecsRemove, id),
  replayRequest: (trafficId, overrides) =>
    ipcRenderer.invoke(IPC.trafficReplay, trafficId, overrides),
  exportHar: (ids) => ipcRenderer.invoke(IPC.trafficExportHar, ids),
  importHar: () => ipcRenderer.invoke(IPC.trafficImportHar),
  recordMocks: (ids, options) => ipcRenderer.invoke(IPC.trafficRecordMocks, ids, options),
  previewMocks: (ids, options) => ipcRenderer.invoke(IPC.trafficPreviewMocks, ids, options),
  getCertStatus: () => ipcRenderer.invoke(IPC.certStatusGet),
  regenerateRootCert: () => ipcRenderer.invoke(IPC.certRegenerate),
  pickFile: (title) => ipcRenderer.invoke(IPC.filePick, title),
  tryScript: (kind, code, trafficId) => ipcRenderer.invoke(IPC.scriptTry, kind, code, trafficId),
  onTraffic: subscribe(IPC.trafficEvent),
  onTrafficCleared: subscribe(IPC.trafficClearedEvent),
  onBreakpointHit: subscribe(IPC.breakpointHitEvent),
  onBreakpointErrors: subscribe(IPC.breakpointErrorsEvent),
  onOpenBreakpoints: subscribe(IPC.openBreakpointsEvent),
  onOpenConnectAi: subscribe(IPC.openConnectAiEvent),
  onOpenProtoSpecs: subscribe(IPC.openProtoSpecsEvent),
  onBreakpointResumed: subscribe(IPC.breakpointResumedEvent),
  onBreakpointsChanged: subscribe(IPC.breakpointsChangedEvent),
  onCertStatus: subscribe(IPC.certStatusEvent),
  onOpenPreferences: subscribe(IPC.openPreferencesEvent),
  onOpenRules: subscribe(IPC.openRulesEvent),
  onOpenScripts: subscribe(IPC.openScriptsEvent),
  onFocusFilter: subscribe(IPC.focusFilterEvent),
  onToggleProxy: subscribe(IPC.toggleProxyEvent),
  onProxyState: subscribe(IPC.proxyStateEvent),
  onProxyError: subscribe(IPC.proxyErrorEvent),
  onSettingsChanged: subscribe(IPC.settingsChangedEvent),
  getProxyState: () => ipcRenderer.invoke(IPC.proxyStateGet),
  getHeldHits: () => ipcRenderer.invoke(IPC.breakpointsHeld),
  getTabs: () => ipcRenderer.invoke(IPC.tabsGet),
  createTab: (duplicateOf) => ipcRenderer.invoke(IPC.tabsCreate, duplicateOf),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.tabsClose, tabId),
  renameTab: (tabId, name) => ipcRenderer.invoke(IPC.tabsRename, tabId, name),
  moveTab: (tabId, toIndex) => ipcRenderer.invoke(IPC.tabsMove, tabId, toIndex),
  setActiveTab: (tabId) => ipcRenderer.invoke(IPC.tabsSetActive, tabId),
  onTabsChanged: subscribe(IPC.tabsChangedEvent),
  onRenameTab: subscribe(IPC.renameTabEvent),
};

contextBridge.exposeInMainWorld('reversee', api);
