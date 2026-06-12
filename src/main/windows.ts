import { BrowserWindow, nativeImage, shell } from 'electron';
import windowStateKeeper from 'electron-window-state';
import log from 'electron-log';
import path from 'node:path';
import iconAsset from '../../resources/icon.png?asset';

const EXTERNAL_LINK_ALLOWLIST = ['https://github.com/galusben/reversee'];

export function createMainWindow(): BrowserWindow {
  const state = windowStateKeeper({ defaultWidth: 1100, defaultHeight: 700 });

  const icon = process.platform === 'linux' ? nativeImage.createFromPath(iconAsset) : undefined;

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    icon,
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  state.manage(win);

  // The renderer never legitimately navigates or opens windows; external
  // links go through shell.openExternal against an allowlist.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_LINK_ALLOWLIST.some((allowed) => url.startsWith(allowed))) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  win.on('ready-to-show', () => {
    log.info('main window ready-to-show');
    win.show();
    win.focus();
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}
