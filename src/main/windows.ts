import { BrowserWindow, nativeImage } from 'electron';
import windowStateKeeper from 'electron-window-state';
import path from 'node:path';
import iconAsset from '../../resources/icon.png?asset';

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

  win.on('ready-to-show', () => {
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
