import { BrowserWindow, nativeImage, shell } from 'electron';
import windowStateKeeper from 'electron-window-state';
import log from 'electron-log';
import path from 'node:path';
import iconAsset from '../../resources/icon.png?asset';

/** How long to wait for ready-to-show before showing the window anyway. */
const REVEAL_FALLBACK_MS = 5000;
/** Grace given to ready-to-show once the page has loaded. */
const REVEAL_AFTER_LOAD_MS = 300;

const EXTERNAL_LINK_ALLOWLIST = ['https://github.com/galusben/reversee'];

/**
 * True for an allowlisted URL or a path/query/fragment under it. A plain
 * prefix test would also accept look-alikes such as ".../reversee-evil".
 */
export function isAllowedExternalLink(url: string): boolean {
  return EXTERNAL_LINK_ALLOWLIST.some(
    (allowed) =>
      url === allowed || (/^[/?#]/.test(url.slice(allowed.length)) && url.startsWith(allowed))
  );
}

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
    if (isAllowedExternalLink(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // ready-to-show is not guaranteed: when the main thread was blocked for a
  // long time during startup (a macOS keychain prompt waiting on the user) it
  // has been seen never to fire, leaving the app running with no window. The
  // page load and a timer are fallbacks, so the window always appears.
  let shown = false;
  const reveal = (reason: string): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    clearTimeout(revealTimer);
    log.info(`main window ${reason}`);
    win.show();
    win.focus();
  };
  const revealTimer = setTimeout(() => reveal('shown by fallback timer'), REVEAL_FALLBACK_MS);
  win.once('ready-to-show', () => reveal('ready-to-show'));
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => reveal('shown after load'), REVEAL_AFTER_LOAD_MS);
  });
  win.once('closed', () => clearTimeout(revealTimer));

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}
