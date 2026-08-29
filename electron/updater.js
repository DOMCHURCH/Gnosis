// Auto-update from GitHub releases.
//
// Downloads happen silently in the background; nothing restarts without the
// user saying so. When a build is staged the renderer shows a toast, and only a
// click on its Restart button calls quitAndInstall(). An agent in the middle of
// a turn must never be interrupted by an update.
//
// NOTE ON VERIFICATION: this can only find an update if the repo actually has a
// published release whose version is above package.json's. Until one exists,
// "checked, nothing newer" is the whole of the observable behaviour — the
// download/notify path is wired but cannot be exercised.

import { app, ipcMain } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

/**
 * @param getWindow  the window to send toast events to
 */
export function registerUpdater(getWindow) {
  // We drive the toast ourselves, so let the download run but never install
  // behind the user's back.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  const send = (channel, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  autoUpdater.on("update-available", (info) => send("update:available", { version: info?.version ?? null }));
  autoUpdater.on("update-downloaded", (info) => send("update:ready", { version: info?.version ?? null }));
  autoUpdater.on("error", (err) => {
    // A failed update check is not worth a dialog. It is normal offline, and
    // normal before the first release is ever published.
    send("update:error", { message: String(err?.message ?? err) });
  });

  ipcMain.on("update:restart", () => {
    // isSilent=false so the NSIS installer shows its progress; isForceRunAfter
    // so the user lands back in Gnosis rather than nowhere.
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("update:check", async () => {
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r?.updateInfo?.version ?? null };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // Only a packaged build has an update feed to check against; in dev
  // electron-updater throws on a missing app-update.yml.
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    /* offline, or no releases published yet */
  });
}
