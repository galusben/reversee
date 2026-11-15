// Application menu. The proxy-behavior checkboxes write to settings (the 1.x
// menu was read directly by the proxy at start time via the remote module);
// snapshot-at-start semantics are preserved because settings are captured in
// the proxy:start payload.
import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { IPC } from '../shared/ipc';
import { getSettings, setSettings, onSettingsChanged, type RootCertPem } from './settings';
import { certificateTrustDialog, exportRootCert } from './certs/certs';
import { checkForUpdatesInteractive } from './updater';

const HOMEPAGE = 'https://github.com/galusben/reversee';

export interface MenuHooks {
  /** The current root CA (it can be regenerated while the app runs). */
  getRoot(): RootCertPem;
  onResetCache(): void;
  onClearTraffic(): void;
  onExportHar(): void;
  onImportHar(): void;
  onRegenerateRootCert(): void;
}

let syncRegistered = false;

export function createMenu(win: BrowserWindow, hooks: MenuHooks): void {
  const isMac = process.platform === 'darwin';
  const settings = getSettings();

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Export HAR…',
          id: 'export-har',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => hooks.onExportHar(),
        },
        {
          label: 'Import HAR…',
          id: 'import-har',
          accelerator: 'CmdOrCtrl+O',
          click: () => hooks.onImportHar(),
        },
        { type: 'separator' },
        {
          label: 'Preferences…',
          id: 'preferences',
          accelerator: 'CmdOrCtrl+,',
          click: () => win.webContents.send(IPC.openPreferencesEvent),
        },
        ...(isMac
          ? []
          : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        ...(isMac
          ? ([
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
              },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Proxy',
      submenu: [
        {
          label: 'Start / Stop Proxy',
          id: 'toggle-proxy',
          accelerator: 'F5',
          click: () => win.webContents.send(IPC.toggleProxyEvent),
        },
        { type: 'separator' },
        {
          label: 'Filter Traffic',
          id: 'focus-filter',
          // Not CmdOrCtrl+F: that must keep working as find inside the editors.
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => win.webContents.send(IPC.focusFilterEvent),
        },
        {
          label: 'Clear Traffic',
          id: 'clear-traffic',
          accelerator: 'CmdOrCtrl+K',
          click: () => hooks.onClearTraffic(),
        },
        { type: 'separator' },
        {
          label: 'Routes && Mocks…',
          id: 'rules',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => win.webContents.send(IPC.openRulesEvent),
        },
        {
          label: 'Scripts…',
          id: 'scripts',
          accelerator: 'CmdOrCtrl+Shift+J',
          click: () => win.webContents.send(IPC.openScriptsEvent),
        },
      ],
    },
    {
      label: 'Breakpoints',
      submenu: [
        {
          label: 'Edit',
          accelerator: 'CmdOrCtrl+B',
          click: () => win.webContents.send(IPC.openBreakpointsEvent),
        },
      ],
    },
    {
      label: 'gRPC',
      submenu: [
        {
          label: 'Proto Specs…',
          click: () => win.webContents.send(IPC.openProtoSpecsEvent),
        },
      ],
    },
    {
      label: 'Proxy Settings',
      submenu: [
        {
          label: 'Rewrite Redirects (3xx)',
          type: 'checkbox',
          checked: settings.rewriteRedirects,
          id: 'redirects',
          click: (item) => setSettings({ rewriteRedirects: item.checked }),
        },
        {
          label: 'Rewrite host',
          type: 'checkbox',
          checked: settings.rewriteHost,
          id: 'host',
          click: (item) => setSettings({ rewriteHost: item.checked }),
        },
        { type: 'separator' },
        {
          label: 'Enable MCP Integration',
          type: 'checkbox',
          checked: settings.mcpEnabled,
          id: 'mcp-enabled',
          click: (item) => setSettings({ mcpEnabled: item.checked }),
        },
        {
          label: 'Allow MCP to Control the Proxy',
          type: 'checkbox',
          checked: settings.mcpAllowControl,
          id: 'mcp-control',
          click: (item) => setSettings({ mcpAllowControl: item.checked }),
        },
        { type: 'separator' },
        {
          label: 'Reset Cache',
          click: () => hooks.onResetCache(),
        },
        {
          label: 'Export Root Cert',
          click: () => void exportRootCert(win, hooks.getRoot()),
        },
        ...(isMac
          ? [
              {
                label: 'Manage Root Cert',
                click: (): void => certificateTrustDialog(win, hooks.getRoot()),
              },
            ]
          : []),
        {
          label: 'Regenerate Root Cert…',
          id: 'regenerate-root',
          click: () => hooks.onRegenerateRootCert(),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: () => void shell.openExternal(HOMEPAGE),
        },
        {
          label: 'Check for Updates…',
          click: () => void checkForUpdatesInteractive(win),
        },
        {
          label: 'Connect an AI Agent (MCP)…',
          click: () => win.webContents.send(IPC.openConnectAiEvent),
        },
        ...(!isMac
          ? [
              {
                label: 'About Reversee',
                click: (): void => app.showAboutPanel(),
              },
            ]
          : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // Keep the checkboxes in sync when settings change from elsewhere
  // (renderer, reset cache, or MCP). Registered once: the menu is rebuilt when
  // the window is re-created, and the listener looks the live menu up by id.
  if (syncRegistered) return;
  syncRegistered = true;
  onSettingsChanged((next) => {
    const menu = Menu.getApplicationMenu();
    const sync = (id: string, checked: boolean): void => {
      const item = menu?.getMenuItemById(id);
      if (item) item.checked = checked;
    };
    sync('redirects', next.rewriteRedirects);
    sync('host', next.rewriteHost);
    sync('mcp-enabled', next.mcpEnabled);
    sync('mcp-control', next.mcpAllowControl);
  });
}
