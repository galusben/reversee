// Application menu. The proxy-behavior checkboxes write to the active tab's
// settings (the 1.x menu was read directly by the proxy at start time via the
// remote module); snapshot-at-start semantics are preserved because settings
// are captured in the proxy:start payload. Proxy items act on the active tab.
import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { IPC } from '../shared/ipc';
import {
  getActiveTabId,
  getSettings,
  setSettings,
  onSettingsChanged,
  type RootCertPem,
} from './settings';
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
  onNewTab(): void;
  onDuplicateTab(): void;
  onCloseTab(): void;
  /** Jump to the tab `offset` places away (wrapping), or to index `at` (8 = last). */
  onSelectTab(target: { offset: number } | { at: number }): void;
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
          label: 'New Tab',
          id: 'new-tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => hooks.onNewTab(),
        },
        {
          label: 'Duplicate Tab',
          id: 'duplicate-tab',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => hooks.onDuplicateTab(),
        },
        {
          label: 'Close Tab',
          id: 'close-tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => hooks.onCloseTab(),
        },
        { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
        { type: 'separator' },
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
      label: 'Tabs',
      submenu: [
        {
          label: 'Rename Tab…',
          id: 'rename-tab',
          click: () => win.webContents.send(IPC.renameTabEvent),
        },
        { type: 'separator' },
        {
          label: 'Next Tab',
          id: 'next-tab',
          accelerator: 'Ctrl+Tab',
          click: () => hooks.onSelectTab({ offset: 1 }),
        },
        {
          label: 'Previous Tab',
          id: 'previous-tab',
          accelerator: 'Ctrl+Shift+Tab',
          click: () => hooks.onSelectTab({ offset: -1 }),
        },
        // Browser-style alternates; hidden, but their shortcuts work.
        {
          label: 'Next Tab',
          visible: false,
          acceleratorWorksWhenHidden: true,
          accelerator: 'CmdOrCtrl+Shift+]',
          click: () => hooks.onSelectTab({ offset: 1 }),
        },
        {
          label: 'Previous Tab',
          visible: false,
          acceleratorWorksWhenHidden: true,
          accelerator: 'CmdOrCtrl+Shift+[',
          click: () => hooks.onSelectTab({ offset: -1 }),
        },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): MenuItemConstructorOptions => ({
          label: `Tab ${n}`,
          accelerator: `CmdOrCtrl+${n}`,
          click: () => hooks.onSelectTab({ at: n - 1 }),
        })),
        {
          label: 'Last Tab',
          accelerator: 'CmdOrCtrl+9',
          click: () => hooks.onSelectTab({ at: 8 }),
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
    // Not the stock Window menu off macOS: its Close item takes Ctrl+W, which closes a tab here.
    isMac ? { role: 'windowMenu' } : { label: 'Window', submenu: [{ role: 'minimize' }] },
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
  onSettingsChanged((next, tabId) => {
    // The checkboxes show the window's tab; a background tab's change is not shown.
    if (tabId !== getActiveTabId()) return;
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
