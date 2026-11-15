import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import log from 'electron-log';
import {
  IPC,
  type BreakpointHit,
  type BreakpointResume,
  type HarExportResult,
  type HarImportResult,
  type ProtoSpecsResult,
  type ReplayOverrides,
  type ReplayResult,
  type RootCertStatus,
  type StartProxyResult,
} from '../shared/ipc';
import type { BreakpointRule, TrafficEntry } from '../shared/types';
import { ProtoStore } from './proto/proto-store';
import { toProxySettings } from '../shared/settings-schema';
import { fromHar, toHar } from '../shared/har';
import {
  getSettings,
  setSettings,
  migrateLegacySettings,
  onSettingsChanged,
  resetCache,
  setSecretCodec,
} from './settings';
import {
  ensureCertificates,
  regenerateRoot,
  rootCertStatus,
  type Certificates,
} from './certs/certs';
import { readClientCert } from './client-cert';
import { replayEntry } from './replay';
import { runScriptTrial } from './script-trial';
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
const isolatedProfile = Boolean(process.env['REVERSEE_USER_DATA']);
if (isolatedProfile) {
  app.setPath('userData', process.env['REVERSEE_USER_DATA'] as string);
}

let win: BrowserWindow | null = null;
let certs: Certificates | null = null;

function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const trafficStore = new TrafficStore();
const protoStore = new ProtoStore(path.join(app.getPath('userData'), 'proto'));

// Correlates a worker streamId to the main-assigned trafficId so the repeated
// notifies of one exchange update the same entry instead of appending. Only
// in-flight exchanges are tracked: the mapping is dropped with the final notify.
const streamToTrafficId = new Map<string, number>();

/**
 * Store an entry and push it to the renderer. With a `streamId` (an exchange
 * the worker reports more than once: pending, streaming, gRPC, WebSocket) the
 * first notify appends a new entry and later ones update it in place; without
 * one (replays, imports) it always appends.
 */
function recordTraffic(entry: TrafficEntry, streamId?: string): TrafficEntry {
  if (streamId !== undefined) {
    const existing = streamToTrafficId.get(streamId);
    if (existing !== undefined) {
      entry.trafficId = existing;
      if (!entry.pending) streamToTrafficId.delete(streamId);
      const updated = trafficStore.update(entry);
      // An evicted or cleared entry is not resurrected by a late update.
      if (updated) sendToRenderer(IPC.trafficEvent, updated);
      return updated ?? entry;
    }
  }
  const stored = trafficStore.add(entry);
  if (streamId !== undefined && entry.pending) streamToTrafficId.set(streamId, stored.trafficId);
  sendToRenderer(IPC.trafficEvent, stored);
  return stored;
}

/**
 * The proxy went away (stopped, killed, crashed): nothing will complete the
 * exchanges still marked in flight, so settle them instead of leaving rows
 * that look like they are loading forever.
 */
function settlePendingTraffic(): void {
  streamToTrafficId.clear();
  for (const entry of trafficStore.getAll()) {
    if (!entry.pending) continue;
    delete entry.pending;
    if (entry.ws) entry.ws.closed = true;
    else if (entry.response.statusCode === undefined) {
      entry.connectorError ??= 'the proxy stopped before a response arrived';
    }
    sendToRenderer(IPC.trafficEvent, entry);
  }
}

function clearTraffic(): void {
  trafficStore.clear();
  streamToTrafficId.clear();
  sendToRenderer(IPC.trafficClearedEvent, undefined);
}

// Breakpoint rules are session-scoped (as in 1.x — they were never persisted).
let breakpointRules: BreakpointRule[] = [];
// Requests/responses currently held at a breakpoint. Main keeps them so an
// agent can list and resume them too, not only the window.
const heldHits = new Map<number, BreakpointHit>();

function setBreakpointRules(rules: BreakpointRule[]): void {
  breakpointRules = rules;
  proxyHost.setBreakpoints(rules);
  sendToRenderer(IPC.breakpointsChangedEvent, rules);
}

function resumeHeld(id: number, params: BreakpointResume): void {
  proxyHost.resumeBreakpoint(id, params);
  heldHits.delete(id);
  sendToRenderer(IPC.breakpointResumedEvent, id);
}

const proxyHost = new ProxyHost({
  onTraffic: (entry, streamId) => recordTraffic(entry, streamId),
  onStateChanged: (running, port) => {
    if (!running) {
      // Stopping closes every held connection; their hits are void.
      heldHits.clear();
      settlePendingTraffic();
    }
    sendToRenderer(IPC.proxyStateEvent, { running, port });
  },
  onServerError: (error) => sendToRenderer(IPC.proxyErrorEvent, error),
  onBreakpointHit: (hit) => {
    heldHits.set(hit.id, hit);
    sendToRenderer(IPC.breakpointHitEvent, hit);
  },
  onBreakpointErrors: (errors) => {
    log.warn('invalid breakpoint patterns', errors);
    sendToRenderer(IPC.breakpointErrorsEvent, errors);
  },
});

/** Shared by the renderer IPC handler and the MCP start_proxy tool. */
async function startProxyFromSettings(): Promise<StartProxyResult> {
  const settings = getSettings();
  if (!settings.dest) {
    return { ok: false, error: { message: 'Destination host is required' } };
  }
  try {
    const leaf = certs?.leaf;
    const sslOptions =
      settings.listenProtocol === 'https' && leaf
        ? { key: leaf.privateKey, cert: leaf.certificate }
        : undefined;
    const port = await proxyHost.start({
      settings: toProxySettings(settings, readClientCert(settings)),
      sslOptions,
    });
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

// ---- root certificate ----

function certStatus(): RootCertStatus {
  if (!certs) throw new Error('certificates are not initialised yet');
  return {
    ...rootCertStatus(certs.root),
    ...(certs.temporaryReason ? { temporary: true, temporaryReason: certs.temporaryReason } : {}),
  };
}

/**
 * Replaces the root CA and re-signs the listener certificate. A running HTTPS
 * listener is restarted so it serves the new certificate immediately.
 */
async function regenerateRootCert(): Promise<RootCertStatus> {
  certs = regenerateRoot();
  log.info('root CA regenerated');
  const status = certStatus();
  sendToRenderer(IPC.certStatusEvent, status);
  if (proxyHost.isRunning && getSettings().listenProtocol === 'https') {
    await startProxyFromSettings();
  }
  return status;
}

async function regenerateRootCertInteractive(): Promise<RootCertStatus> {
  const options = {
    type: 'warning' as const,
    buttons: ['Regenerate', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Regenerate the root certificate?',
    detail:
      'A new root CA replaces the current one. Clients that trusted the old ' +
      'certificate will reject HTTPS connections to Reversee until you trust ' +
      'the new one (Proxy Settings → Manage / Export Root Cert).',
  };
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 0 ? regenerateRootCert() : certStatus();
}

// ---- HAR export / import ----

async function exportHar(ids?: number[]): Promise<HarExportResult> {
  const all = trafficStore.getAll();
  const wanted = ids ? new Set(ids) : null;
  const entries = wanted ? all.filter((e) => wanted.has(e.trafficId)) : all;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const options: SaveDialogOptions = {
    title: 'Export traffic as HAR',
    defaultPath: `reversee-${stamp}.har`,
    filters: [
      { name: 'HTTP Archive', extensions: ['har'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  };
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    await fs.writeFile(filePath, JSON.stringify(toHar(entries, app.getVersion()), null, 2), 'utf8');
    return { ok: true, path: filePath, count: entries.length };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function importHar(): Promise<HarImportResult> {
  const options: OpenDialogOptions = {
    title: 'Import HAR',
    filters: [
      { name: 'HTTP Archive', extensions: ['har', 'json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  };
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
  try {
    const entries = fromHar(JSON.parse(await fs.readFile(filePaths[0], 'utf8')));
    // Only the newest entries can fit; skip the ones that would be evicted at once.
    const kept = entries.slice(-getSettings().trafficCap);
    for (const entry of kept) recordTraffic(entry);
    return { ok: true, count: kept.length };
  } catch (error) {
    return { ok: false, error: `Could not import: ${(error as Error).message}` };
  }
}

/** Menu-triggered variants report failures themselves (there is no caller to tell). */
async function reportingErrors(
  action: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>,
  title: string
): Promise<void> {
  const result = await action();
  if (!result.ok && !result.canceled) dialog.showErrorBox(title, result.error ?? 'Unknown error');
}

async function replayFromUi(trafficId: unknown, overrides: unknown): Promise<ReplayResult> {
  const entry = typeof trafficId === 'number' ? trafficStore.get(trafficId) : undefined;
  if (!entry) return { ok: false, error: 'That request is no longer in the list.' };
  try {
    const replayed = await replayEntry(entry, (overrides ?? {}) as ReplayOverrides, getSettings());
    return { ok: true, trafficId: recordTraffic(replayed).trafficId };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
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
  ipcMain.handle(IPC.trafficClear, () => clearTraffic());
  ipcMain.handle(IPC.trafficReplay, (_event, trafficId: unknown, overrides: unknown) =>
    replayFromUi(trafficId, overrides)
  );
  ipcMain.handle(IPC.trafficExportHar, (_event, ids: unknown) =>
    exportHar(
      Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : undefined
    )
  );
  ipcMain.handle(IPC.trafficImportHar, () => importHar());
  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });

  ipcMain.handle(IPC.breakpointsGet, () => breakpointRules);
  ipcMain.handle(IPC.breakpointsSet, (_event, rules: BreakpointRule[]) => {
    setBreakpointRules(rules);
  });
  ipcMain.handle(IPC.breakpointResume, (_event, id: number, params: BreakpointResume) => {
    resumeHeld(id, params);
  });

  ipcMain.handle(IPC.scriptTry, (_event, kind: unknown, code: unknown, trafficId: unknown) =>
    runScriptTrial(proxyHost, trafficStore, kind, code, trafficId)
  );
  ipcMain.handle(IPC.certStatusGet, () => certStatus());
  ipcMain.handle(IPC.certRegenerate, () => regenerateRootCertInteractive());
  ipcMain.handle(IPC.filePick, async (_event, title: unknown): Promise<string | null> => {
    const options: OpenDialogOptions = {
      title: typeof title === 'string' ? title : 'Choose a file',
      filters: [
        { name: 'PEM', extensions: ['pem', 'crt', 'cer', 'key'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    };
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return canceled || filePaths.length === 0 ? null : filePaths[0];
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

/** Settings that main itself acts on (the rest are read when the proxy starts). */
function applyAppSettings(): void {
  const settings = getSettings();
  trafficStore.setCap(settings.trafficCap);
  // Keeps native chrome (title bar, menus, dialogs) in step with the UI theme.
  nativeTheme.themeSource = settings.theme;
  // Routes and mocks apply to the running proxy at once; no restart needed.
  proxyHost.setRules({ routes: settings.routes, mocks: settings.mocks });
  // So do the interceptor scripts.
  proxyHost.setScripts({
    interceptRequest: settings.interceptRequest,
    requestInterceptor: settings.requestInterceptor,
    interceptResponse: settings.interceptResponse,
    responseInterceptor: settings.responseInterceptor,
  });
}

/**
 * Encrypt the root CA key with the OS keychain — but only for the real
 * profile of a packaged app. Development runs and isolated profiles (tests,
 * throwaway headless agent instances) must never raise a keychain prompt, and
 * Linux's "basic_text" backend is obfuscation, not encryption.
 */
function setupSecretStorage(): void {
  if (!app.isPackaged || isolatedProfile) return;
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return;
    }
    setSecretCodec({
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
    });
  } catch (error) {
    log.warn('system keychain unavailable; the root CA key stays in the settings file', error);
  }
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
          setBreakpointRules,
          getHeldHits: () => [...heldHits.values()],
          resumeHeld,
          startProxy: startProxyFromSettings,
          protoStore,
          syncProtoSpecs,
          recordTraffic,
          getCertStatus: certStatus,
          regenerateRootCert,
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
    setupSecretStorage();
    certs = ensureCertificates();
    registerIpc();
    applyAppSettings();
    onSettingsChanged(applyAppSettings);
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
      getRoot: () => (certs as Certificates).root,
      onResetCache: (): void => {
        resetCache();
        clearTraffic();
      },
      onClearTraffic: clearTraffic,
      onExportHar: (): void => void reportingErrors(() => exportHar(), 'HAR export failed'),
      onImportHar: (): void => void reportingErrors(importHar, 'HAR import failed'),
      onRegenerateRootCert: (): void => void regenerateRootCertInteractive(),
    };
    createMenu(win, menuHooks);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        win = createMainWindow();
        createMenu(win, menuHooks);
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
