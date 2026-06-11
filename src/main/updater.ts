// Auto-update via GitHub Releases (replaces the 1.x S3 feed).
import { app, dialog, type BrowserWindow } from 'electron';
import log from 'electron-log';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

export function setupUpdater(): void {
  autoUpdater.logger = log;
  if (app.isPackaged) {
    void autoUpdater.checkForUpdatesAndNotify();
  }
}

/** Menu-triggered check with user feedback. */
export async function checkForUpdatesInteractive(win: BrowserWindow): Promise<void> {
  if (!app.isPackaged) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Updates are only available in packaged builds.',
    });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdatesAndNotify();
    if (!result?.updateInfo || result.updateInfo.version === app.getVersion()) {
      await dialog.showMessageBox(win, {
        type: 'info',
        message: `You are on the latest version (${app.getVersion()}).`,
      });
    }
  } catch (error) {
    log.warn('update check failed', error);
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Could not check for updates. See the log for details.',
    });
  }
}
