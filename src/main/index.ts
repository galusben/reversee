import { app, BrowserWindow, clipboard, ipcMain } from 'electron';
import log from 'electron-log';
import { IPC, type StartProxyResult } from '../shared/ipc';
import { toProxySettings } from '../shared/settings-schema';
import {
  getSettings,
  setSettings,
  migrateLegacySettings,
  onSettingsChanged,
} from './settings';
import { ensureCertificates, type LeafCert } from './certs/certs';
import { ProxyHost } from './proxy-host';
import { TrafficStore } from './traffic-store';
import { createMainWindow } from './windows';

log.transports.file.level = 'info';
log.transports.console.level = 'info';

let win: BrowserWindow | null = null;
let leafCert: LeafCert | null = null;

function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const trafficStore = new TrafficStore();

const proxyHost = new ProxyHost({
  onTraffic: (entry) => sendToRenderer(IPC.trafficEvent, trafficStore.add(entry)),
  onStateChanged: (running, port) => sendToRenderer(IPC.proxyStateEvent, { running, port }),
  onServerError: (error) => sendToRenderer(IPC.proxyErrorEvent, error),
  onBreakpointHit: () => {
    // Breakpoint UI lands in a later milestone; requests are never gated until
    // breakpoint rules exist, so nothing can be held here yet.
  },
  onBreakpointErrors: (errors) => log.warn('invalid breakpoint patterns', errors),
});

function registerIpc(): void {
  ipcMain.handle(IPC.proxyStart, async (): Promise<StartProxyResult> => {
    const settings = getSettings();
    if (!settings.dest) {
      return { ok: false, error: { message: 'Destination host is required' } };
    }
    try {
      const sslOptions =
        settings.listenProtocol === 'https' && leafCert
          ? { key: leafCert.privateKey, cert: leafCert.certificate }
          : undefined;
      const port = await proxyHost.start({ settings: toProxySettings(settings), sslOptions });
      return { ok: true, port };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { ok: false, error: { code: e.code, message: e.message ?? String(error) } };
    }
  });

  ipcMain.handle(IPC.proxyStop, () => {
    proxyHost.stop();
  });

  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsSet, (_event, patch: unknown) => setSettings(patch));
  ipcMain.handle(IPC.settingsMigrateLegacy, (_event, old: unknown) => {
    migrateLegacySettings(old);
  });
  ipcMain.handle(IPC.appVersion, () => app.getVersion());

  ipcMain.handle(IPC.trafficGetAll, () => trafficStore.getAll());
  ipcMain.handle(IPC.trafficClear, () => {
    trafficStore.clear();
    sendToRenderer(IPC.trafficClearedEvent, undefined);
  });
  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });

  onSettingsChanged((settings) => sendToRenderer(IPC.settingsChangedEvent, settings));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const { leaf } = ensureCertificates();
    leafCert = leaf;
    registerIpc();
    win = createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        win = createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    proxyHost.kill();
    app.quit();
  });
}
