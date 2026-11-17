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
  type BreakpointResume,
  type HarExportResult,
  type HarImportResult,
  type ProtoSpecsResult,
  type ReplayOverrides,
  type ReplayResult,
  type RootCertStatus,
  type StartProxyResult,
} from '../shared/ipc';
import type { BreakpointRule } from '../shared/types';
import { ProtoStore } from './proto/proto-store';
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
  createHostCertIssuer,
  ensureCertificates,
  regenerateRoot,
  rootCertStatus,
  type Certificates,
} from './certs/certs';
import { replayEntry } from './replay';
import { runScriptTrial } from './script-trial';
import { SessionManager } from './session-manager';
import type { Session } from './session';
import { createMainWindow } from './windows';
import { createMenu } from './menu';
import { setupUpdater } from './updater';
import { createMcpHandlers, MCP_MUTATING_METHODS } from './mcp/handlers';
import { startControlServer, type ControlServer } from './mcp/control-server';
import { parseCliFlags } from './cli-args';
import { saveRecordedMocks } from './record-mocks';
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

const protoStore = new ProtoStore(path.join(app.getPath('userData'), 'proto'));

/** Signs per-host certificates for capture-anything mode; rebuilt when the root changes. */
let hostCerts: {
  root: Certificates['root'];
  issue: ReturnType<typeof createHostCertIssuer>;
} | null = null;

// Created once the app is ready (it reads the saved tabs from settings).
let sessions: SessionManager;

/**
 * The window shows one tab at a time. Its proxy, traffic and breakpoint
 * events go to the renderer; every tab's counters reach the tab strip
 * through the tabs summary.
 */
function sendForTab(session: Session, channel: string, payload: unknown): void {
  if (session.id === sessions.activeTabId) sendToRenderer(channel, payload);
}

function createSessions(): SessionManager {
  return new SessionManager({
    getLeafCert: () => {
      const leaf = certs?.leaf;
      return leaf ? { key: leaf.privateKey, cert: leaf.certificate } : undefined;
    },
    issueCert: (host) => {
      if (!certs) throw new Error('certificates are not initialised yet');
      if (!hostCerts || hostCerts.root !== certs.root) {
        hostCerts = { root: certs.root, issue: createHostCertIssuer(certs.root) };
      }
      const leaf = hostCerts.issue(host);
      return { key: leaf.privateKey, cert: leaf.certificate };
    },
    events: {
      traffic: (session, entry) => sendForTab(session, IPC.trafficEvent, entry),
      trafficCleared: (session) => sendForTab(session, IPC.trafficClearedEvent, session.id),
      state: (session) =>
        sendForTab(session, IPC.proxyStateEvent, {
          running: session.isRunning,
          port: session.boundPort,
          tabId: session.id,
        }),
      error: (session, error) => sendForTab(session, IPC.proxyErrorEvent, error),
      breakpointHit: (session, hit) => sendForTab(session, IPC.breakpointHitEvent, hit),
      breakpointResumed: (session, id) => sendForTab(session, IPC.breakpointResumedEvent, id),
      breakpointsChanged: (session, rules) =>
        sendForTab(session, IPC.breakpointsChangedEvent, rules),
      breakpointErrors: (session, errors) => sendForTab(session, IPC.breakpointErrorsEvent, errors),
      tabsChanged: (snapshot) => sendToRenderer(IPC.tabsChangedEvent, snapshot),
    },
  });
}

/** Shared by the renderer IPC handler and the MCP start_proxy tool. */
function startProxy(session: Session = sessions.active()): Promise<StartProxyResult> {
  return session.start();
}

/**
 * Closes a tab from the window (strip or menu). A running proxy or a held
 * request is live work, so that asks first.
 */
async function closeTabInteractive(tabId: string): Promise<boolean> {
  const session = sessions.get(tabId);
  if (!session) return false;
  if (session.isRunning || session.heldHits.length) {
    const name = sessions.snapshot().tabs.find((t) => t.id === tabId)?.name ?? tabId;
    const options = {
      type: 'question' as const,
      buttons: ['Close Tab', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Close "${name}"?`,
      detail: session.heldHits.length
        ? 'Its proxy is holding requests at a breakpoint. Closing the tab stops the proxy and drops them.'
        : 'Its proxy is running. Closing the tab stops it.',
    };
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (response !== 0) return false;
  }
  return sessions.close(tabId);
}

function newTab(duplicateOf?: string): void {
  const result = sessions.create(duplicateOf ? { duplicateOf } : {});
  if (!result.ok) dialog.showErrorBox('Could not open a tab', result.error);
}

/** Moves to the tab `offset` places away in the strip (wrapping), or to index `at`. */
function selectTab(target: { offset: number } | { at: number }): void {
  const tabs = sessions.snapshot().tabs;
  if (tabs.length === 0) return;
  let index: number;
  if ('at' in target) {
    // Like browsers: ⌘9 is always the last tab.
    index = target.at >= 8 ? tabs.length - 1 : target.at;
    if (index >= tabs.length) return;
  } else {
    const current = tabs.findIndex((t) => t.id === sessions.activeTabId);
    index = (current + target.offset + tabs.length) % tabs.length;
  }
  sessions.setActive((tabs[index] as { id: string }).id);
}

/**
 * Recompiles the saved proto specs, pushes the bundle to the proxy worker (so
 * live gRPC traffic decodes), and returns the list + any compile errors for the
 * renderer. Shared by the IPC handlers and the MCP proto-spec tools.
 */
function syncProtoSpecs(): ProtoSpecsResult {
  const { specs, methodMap, errors } = protoStore.compile();
  sessions.setProtoSpecs({ specs, methodMap });
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
  for (const session of sessions.all()) {
    const settings = session.settings;
    if (session.isRunning && (settings.listenProtocol === 'https' || settings.captureAll)) {
      await session.start();
    }
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
  const all = sessions.active().trafficStore.getAll();
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
    const session = sessions.active();
    const kept = entries.slice(-session.settings.trafficCap);
    for (const entry of kept) session.recordTraffic(entry);
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
  const found = typeof trafficId === 'number' ? sessions.findTraffic(trafficId) : undefined;
  if (!found) return { ok: false, error: 'That request is no longer in the list.' };
  const { session, entry } = found;
  try {
    const replayed = await replayEntry(
      entry,
      (overrides ?? {}) as ReplayOverrides,
      session.settings
    );
    return { ok: true, trafficId: session.recordTraffic(replayed).trafficId };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.proxyStart, () => startProxy());

  ipcMain.handle(IPC.proxyStop, () => {
    sessions.active().stop();
  });
  ipcMain.handle(IPC.proxyStateGet, () => {
    const session = sessions.active();
    return { running: session.isRunning, port: session.boundPort, tabId: session.id };
  });

  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsSet, (_event, patch: unknown) => setSettings(patch));
  ipcMain.handle(IPC.settingsMigrateLegacy, (_event, old: unknown) => {
    migrateLegacySettings(old);
  });
  ipcMain.handle(IPC.appVersion, () => app.getVersion());

  ipcMain.handle(IPC.trafficGetAll, () => sessions.active().trafficStore.getAll());
  ipcMain.handle(IPC.trafficClear, () => sessions.active().clearTraffic());
  ipcMain.handle(IPC.trafficReplay, (_event, trafficId: unknown, overrides: unknown) =>
    replayFromUi(trafficId, overrides)
  );
  ipcMain.handle(IPC.trafficExportHar, (_event, ids: unknown) =>
    exportHar(
      Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : undefined
    )
  );
  ipcMain.handle(IPC.trafficImportHar, () => importHar());
  ipcMain.handle(IPC.trafficRecordMocks, (_event, ids: unknown, options: unknown) => {
    const wanted = Array.isArray(ids) ? new Set(ids.filter((id) => typeof id === 'number')) : null;
    const session = sessions.active();
    const all = session.trafficStore.getAll();
    const o = (options ?? {}) as Record<string, unknown>;
    return saveRecordedMocks(
      wanted ? all.filter((e) => wanted.has(e.trafficId)) : all,
      { ignoreQuery: o['ignoreQuery'] === true, enabled: o['enabled'] !== false },
      session.id
    );
  });
  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });

  ipcMain.handle(IPC.breakpointsGet, () => sessions.active().rules);
  ipcMain.handle(IPC.breakpointsSet, (_event, rules: BreakpointRule[]) => {
    sessions.active().setBreakpointRules(rules);
  });
  ipcMain.handle(IPC.breakpointsHeld, () => sessions.active().heldHits);
  ipcMain.handle(IPC.breakpointResume, (_event, id: number, params: BreakpointResume) => {
    sessions.findHeld(id)?.resumeHeld(id, params);
  });

  ipcMain.handle(IPC.scriptTry, (_event, kind: unknown, code: unknown, trafficId: unknown) => {
    const found = typeof trafficId === 'number' ? sessions.findTraffic(trafficId) : undefined;
    const session = found?.session ?? sessions.active();
    return runScriptTrial(
      session.proxyHost,
      session.trafficStore,
      kind,
      code,
      trafficId,
      session.settings
    );
  });

  ipcMain.handle(IPC.tabsGet, () => sessions.snapshot());
  ipcMain.handle(IPC.tabsCreate, (_event, duplicateOf: unknown) => {
    const result = sessions.create(typeof duplicateOf === 'string' ? { duplicateOf } : {});
    return result.ok ? { ok: true, tabId: result.tab.id } : result;
  });
  ipcMain.handle(IPC.tabsClose, (_event, tabId: unknown) =>
    typeof tabId === 'string' ? closeTabInteractive(tabId) : false
  );
  ipcMain.handle(IPC.tabsRename, (_event, tabId: unknown, name: unknown) => {
    if (typeof tabId !== 'string' || typeof name !== 'string') {
      return { ok: false, error: 'tabId and name are required' };
    }
    const result = sessions.rename(tabId, name);
    return result.ok ? { ok: true, tabId: result.tab.id } : result;
  });
  ipcMain.handle(IPC.tabsMove, (_event, tabId: unknown, toIndex: unknown) => {
    if (typeof tabId === 'string' && typeof toIndex === 'number') sessions.move(tabId, toIndex);
  });
  ipcMain.handle(IPC.tabsSetActive, (_event, tabId: unknown) => {
    if (typeof tabId === 'string' && sessions.get(tabId)) sessions.setActive(tabId);
  });
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

  onSettingsChanged((settings, tabId) => {
    if (tabId === sessions.activeTabId) sendToRenderer(IPC.settingsChangedEvent, settings);
  });
}

/** App-wide settings main acts on (each tab applies its own; see Session.applySettings). */
function applyAppSettings(): void {
  // Keeps native chrome (title bar, menus, dialogs) in step with the UI theme.
  nativeTheme.themeSource = getSettings().theme;
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
          sessions,
          protoStore,
          syncProtoSpecs,
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
    sessions = createSessions();
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
        sessions.dispose();
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
      },
      onClearTraffic: (): void => sessions.active().clearTraffic(),
      onNewTab: (): void => newTab(),
      onDuplicateTab: (): void => newTab(sessions.activeTabId),
      onCloseTab: (): void => void closeTabInteractive(sessions.activeTabId),
      onSelectTab: selectTab,
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
      sessions.dispose();
      void controlServer?.close();
      app.quit();
    });
  }
}
