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

export function createMenu(
  win: BrowserWindow,
  root: RootCertPem,
  hooks: { onResetCache(): void }
): void {
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
          label: 'Reset Cache',
          click: () => hooks.onResetCache(),
        },
        {
          label: 'Export Root Cert',
          click: () => void exportRootCert(win, root),
        },
        ...(isMac
          ? [
              {
                label: 'Manage Root Cert',
                click: (): void => certificateTrustDialog(win, root),
              },
            ]
          : []),
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
  // (renderer, reset cache, or MCP later).
  onSettingsChanged((next) => {
    const menu = Menu.getApplicationMenu();
    const redirects = menu?.getMenuItemById('redirects');
    const host = menu?.getMenuItemById('host');
    if (redirects) redirects.checked = next.rewriteRedirects;
    if (host) host.checked = next.rewriteHost;
  });
}
