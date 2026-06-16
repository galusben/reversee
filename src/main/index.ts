import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import log from 'electron-log';
import {
  IPC,
  type BreakpointResume,
  type ProtoSpecsResult,
  type StartProxyResult,
} from '../shared/ipc';
import type { BreakpointRule } from '../shared/types';
import { ProtoStore } from './proto/proto-store';
import { toProxySettings } from '../shared/settings-schema';
import {
  getSettings,
  setSettings,
  migrateLegacySettings,
  onSettingsChanged,
  resetCache,
} from './settings';
import { ensureCertificates, type LeafCert } from './certs/certs';
import { ProxyHost } from './proxy-host';
import { TrafficStore } from './traffic-store';
import { createMainWindow } from './windows';
import { createMenu } from './menu';
import { setupUpdater } from './updater';
import { createMcpHandlers, MCP_MUTATING_METHODS } from './mcp/handlers';
import { startControlServer, type ControlServer } from './mcp/control-server';
import { parseCliFlags } from './cli-args';
import iconAsset from '../../resources/icon.png?asset';

log.transports.file.level = 'info';
log.transports.console.level = 'info';
log.info('main process start');

const flags = parseCliFlags(process.argv);

// Test isolation: e2e runs point this at a temp dir so settings, certs, and
// window state never touch (or depend on) the real profile.
if (process.env['REVERSEE_USER_DATA']) {
  app.setPath('userData', process.env['REVERSEE_USER_DATA']);
}

let win: BrowserWindow | null = null;
let leafCert: LeafCert | null = null;

function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const trafficStore = new TrafficStore();
const protoStore = new ProtoStore(path.join(app.getPath('userData'), 'proto'));

const proxyHost = new ProxyHost({
  onTraffic: (entry) => sendToRenderer(IPC.trafficEvent, trafficStore.add(entry)),
  onStateChanged: (running, port) => sendToRenderer(IPC.proxyStateEvent, { running, port }),
  onServerError: (error) => sendToRenderer(IPC.proxyErrorEvent, error),
  onBreakpointHit: (hit) => sendToRenderer(IPC.breakpointHitEvent, hit),
  onBreakpointErrors: (errors) => {
    log.warn('invalid breakpoint patterns', errors);
    sendToRenderer(IPC.breakpointErrorsEvent, errors);
  },
});

// Breakpoint rules are session-scoped (as in 1.x — they were never persisted).
let breakpointRules: BreakpointRule[] = [];

/** Shared by the renderer IPC handler and the MCP start_proxy tool. */
async function startProxyFromSettings(): Promise<StartProxyResult> {
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
}

/**
 * Recompiles the saved proto specs, pushes the bundle to the proxy worker (so
 * live gRPC traffic decodes), and returns the list + any compile errors for the
 * renderer. Shared by the IPC handlers and the MCP proto-spec tools.
 */
function syncProtoSpecs(): ProtoSpecsResult {
  const { specs, methodMap, errors } = protoStore.compile();
  proxyHost.setProtoSpecs({ specs, methodMap });
  return { specs: protoStore.list(), errors };
}

function registerIpc(): void {
  ipcMain.handle(IPC.proxyStart, () => startProxyFromSettings());

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

  ipcMain.handle(IPC.breakpointsGet, () => breakpointRules);
  ipcMain.handle(IPC.breakpointsSet, (_event, rules: BreakpointRule[]) => {
    breakpointRules = rules;
    proxyHost.setBreakpoints(rules);
  });
  ipcMain.handle(IPC.breakpointResume, (_event, id: number, params: BreakpointResume) => {
    proxyHost.resumeBreakpoint(id, params);
  });

  ipcMain.handle(IPC.protoSpecsGet, () => syncProtoSpecs());
  ipcMain.handle(IPC.protoSpecsImport, async (): Promise<ProtoSpecsResult> => {
    if (!win) return syncProtoSpecs();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import proto spec',
      filters: [
        { name: 'Protobuf', extensions: ['proto', 'desc'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return syncProtoSpecs();
    const file = filePaths[0];
    const isDescriptor = file.toLowerCase().endsWith('.desc');
    protoStore.add({
      name: path.basename(file),
      source: isDescriptor ? 'descriptor' : 'proto',
      content: isDescriptor ? await fs.readFile(file) : await fs.readFile(file, 'utf8'),
    });
    return syncProtoSpecs();
  });
  ipcMain.handle(IPC.protoSpecsRemove, (_event, id: unknown) => {
    if (typeof id === 'string') protoStore.remove(id);
    return syncProtoSpecs();
  });

  onSettingsChanged((settings) => sendToRenderer(IPC.settingsChangedEvent, settings));
}

// ---- MCP control socket ----

let controlServer: ControlServer | null = null;
let controlServerBusy = false;

async function syncControlServer(): Promise<void> {
  if (controlServerBusy) return;
  controlServerBusy = true;
  try {
    const enabled = flags.mcp ?? getSettings().mcpEnabled;
    if (enabled && !controlServer) {
      controlServer = await startControlServer({
        dir: app.getPath('userData'),
        appVersion: app.getVersion(),
        isControlAllowed: () => flags.allowMcpControl || getSettings().mcpAllowControl,
        mutatingMethods: MCP_MUTATING_METHODS,
        handlers: createMcpHandlers({
          proxyHost,
          trafficStore,
          getBreakpointRules: () => breakpointRules,
          startProxy: startProxyFromSettings,
          protoStore,
          syncProtoSpecs,
        }),
        logger: log,
      });
    } else if (!enabled && controlServer) {
      const server = controlServer;
      controlServer = null;
      await server.close();
    }
  } catch (error) {
    log.error('failed to toggle MCP control server', error);
  } finally {
    controlServerBusy = false;
  }
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
    const { root, leaf } = ensureCertificates();
    leafCert = leaf;
    registerIpc();
    syncProtoSpecs(); // prime the worker bundle for when the proxy starts
    void syncControlServer();
    onSettingsChanged(() => void syncControlServer());

    // Headless (agent) mode: no window, dock, menu, or auto-update — just the
    // proxy and the MCP control socket. Runs until killed.
    if (flags.headless) {
      app.dock?.hide();
      log.info(
        `Reversee running headless — MCP ${flags.mcp === false ? 'disabled' : 'enabled'}, ` +
          `control ${flags.allowMcpControl ? 'ALLOWED' : 'read-only'}.`
      );
      const shutdown = (): void => {
        proxyHost.kill();
        void controlServer?.close();
        app.quit();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }

    setupUpdater();
    win = createMainWindow();

    app.setAboutPanelOptions({
      applicationName: 'Reversee',
      applicationVersion: app.getVersion(),
      website: 'https://github.com/galusben/reversee',
      iconPath: iconAsset,
    });

    const menuHooks = {
      onResetCache: (): void => {
        resetCache();
        trafficStore.clear();
        sendToRenderer(IPC.trafficClearedEvent, undefined);
      },
    };
    createMenu(win, root, menuHooks);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        win = createMainWindow();
        createMenu(win, root, menuHooks);
      }
    });
  });

  // GUI mode only: headless never opens a window, so it stays alive on the
  // control socket until it receives a termination signal.
  if (!flags.headless) {
    app.on('window-all-closed', () => {
      proxyHost.kill();
      void controlServer?.close();
      app.quit();
    });
  }
}
