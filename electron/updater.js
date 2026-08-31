// Update checking from GitHub releases. Checking only — nothing is downloaded
// and nothing is installed.
//
// WHY THIS DOES NOT AUTO-UPDATE, WHEN IT USED TO
//
// The installer is not code-signed. Bitdefender classified both
// Gnosis-Setup-1.2.0.exe and a bundled index.js as Atc4.Detection — a generic
// behavioural heuristic, not a named signature — and quarantined them. What that
// looked like on the receiving end was not a warning: it was a deleted payload,
// a Start Menu shortcut pointing at nothing, and a source file the on-access
// scanner then refused to let anything recreate. An unsigned installer that
// unpacks itself into %TEMP% and runs code from there is, to a heuristic engine,
// indistinguishable from a dropper. It will keep being flagged.
//
// A background download makes that failure arrive unannounced. The user is not
// installing anything, has no reason to connect the antivirus alarm to Gnosis,
// and is left with a broken install and no obvious way back. A user who ignores
// an update reminder is merely on an old build. A user whose antivirus
// interrupts a silent install is on a broken one. The second is much worse, so
// this trades silent updates for reliability until the installer is signed.
//
// autoDownload is false rather than just autoInstallOnAppQuit, and the
// distinction matters: the quarantined file was the .exe ITSELF, so merely
// having it on disk is enough to trigger the detection. Downloading it and
// declining to run it would still produce the pop-up and the alarm.
//
// WHEN THIS CAN BE REVERTED: once the installer is code-signed by a verified
// publisher. That is the actual fix; this is what keeps people working until it
// lands. Reverting before then reintroduces the exact failure described above.

import { app, ipcMain, shell, Notification } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const RELEASES_URL = "https://github.com/DOMCHURCH/Gnosis/releases/latest";

/**
 * @param getWindow  the window to send toast events to
 */
export function registerUpdater(getWindow) {
  // Check, tell, and stop. See the note above before changing either of these.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  const send = (channel, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  const openReleases = () => {
    void shell.openExternal(RELEASES_URL);
  };

  // Remembered so the six-hourly re-check does not re-notify about a version the
  // user has already been told about. A reminder that reappears every six hours
  // is not a reminder, it is nagging, and nagging gets dismissed unread.
  let notifiedVersion = null;

  autoUpdater.on("update-available", (info) => {
    const version = info?.version ?? null;
    send("update:available", { version, url: RELEASES_URL });

    if (version && version === notifiedVersion) return;
    notifiedVersion = version;

    // A native notification as well as the in-app toast, because Gnosis lives in
    // the tray: the window the toast would appear in may not be open, and often
    // is not for days at a time.
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `Gnosis ${version ? `v${version}` : "update"} is available`,
        body: "Your version is out of date. Click to download the new installer.",
        silent: false,
      });
      n.on("click", openReleases);
      n.show();
    }
  });

  autoUpdater.on("error", (err) => {
    // A failed update check is not worth a dialog. It is normal offline.
    send("update:error", { message: String(err?.message ?? err) });
  });

  // Replaces the old update:restart. There is nothing staged to restart into —
  // the user downloads and installs deliberately, at a moment of their choosing,
  // when an antivirus prompt is comprehensible rather than mysterious.
  ipcMain.removeAllListeners("update:open-releases");
  ipcMain.on("update:open-releases", openReleases);

  ipcMain.removeHandler?.("update:check");
  ipcMain.handle("update:check", async () => {
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r?.updateInfo?.version ?? null, url: RELEASES_URL };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  // Only a packaged build has an update feed to check against; in dev
  // electron-updater throws on a missing app-update.yml.
  if (!app.isPackaged) return;

  const check = () =>
    // checkForUpdates, not checkForUpdatesAndNotify: the latter is a thin wrapper
    // that downloads and posts its own notification, which is the behaviour this
    // file exists to prevent.
    autoUpdater.checkForUpdates().catch(() => {
      /* offline, or no releases published yet */
    });

  check();

  /*
   * Re-check while the app is open.
   *
   * Gnosis is a tray app people leave running for days, so "once at launch"
   * could mean once a week — a release could ship on Monday and not be noticed
   * until the machine rebooted. Six hours is frequent enough that a release
   * lands the same day and rare enough to be invisible: it is one small HTTPS
   * request, and when nothing is new it does nothing at all.
   */
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const timer = setInterval(check, SIX_HOURS);
  // Do not hold the process open on this alone — a tray app that cannot exit
  // because of its own update timer is a worse bug than a stale build.
  timer.unref?.();
  app.on("before-quit", () => clearInterval(timer));
}
