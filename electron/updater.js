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
  autoUpdater.autoDownload = true;
  /*
   * THE reason people sat on old builds.
   *
   * This was false, with the stated intent "never install behind the user's
   * back". The intent was right and the setting was the wrong way to express
   * it, because it does not mean "ask first" — it means DISCARD. The flow was:
   * launch, download the update silently, show a toast, and if the user closes
   * the app without clicking Restart, throw the staged build away. Next launch:
   * same old version, download it again, toast again. Anyone who did not happen
   * to click that one button was pinned on their original install forever, and
   * re-downloading ~120MB every launch to delete it again.
   *
   * True does not interrupt anything. The app is already closing — no turn is in
   * flight, nothing is lost — and the user lands on the new version next time
   * they open it. The property that actually mattered, never yanking the process
   * out from under a running agent, is preserved by autoDownload + the toast:
   * the only thing that restarts a LIVE app is still the user clicking Restart.
   */
  autoUpdater.autoInstallOnAppQuit = true;

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

  const check = () =>
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      /* offline, or no releases published yet */
    });

  check();

  /*
   * Re-check while the app is open.
   *
   * The check used to run exactly once, at launch. Gnosis is a tray app people
   * leave running for days, so "once at launch" could mean once a week — a
   * release could ship on Monday and not be noticed until the machine rebooted.
   * Six hours is frequent enough that a release lands the same day and rare
   * enough to be invisible: it is one small HTTPS request, and when nothing is
   * new it does nothing at all.
   */
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const timer = setInterval(check, SIX_HOURS);
  // Do not hold the process open on this alone — a tray app that cannot exit
  // because of its own update timer is a worse bug than a stale build.
  timer.unref?.();
  app.on("before-quit", () => clearInterval(timer));
}
