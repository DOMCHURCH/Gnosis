// Browser notifications for phone use. The point of handing work over is that you lock
// the phone and walk away, which only works if something tells you when the work
// lands or stalls — the desktop notifier fires on the machine running Gnosis, not
// in your pocket.
//
// Permission is requested only when a background mode is chosen. Asking on page
// load is how sites get permanently denied, and a denied permission is not
// recoverable from script.

/** True when this browser can show notifications at all. */
export function canNotify() {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Ask for permission, once, at the moment it becomes meaningful. Never throws. */
export async function requestNotifyPermission() {
  if (!canNotify()) return false;
  try {
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false; // asking again is a no-op
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Show a notification. Silently does nothing without permission — a page that
 * throws because the user said no is worse than one that stays quiet.
 */
export function notify(title, body) {
  if (!canNotify()) return;
  try {
    if (Notification.permission !== "granted") return;
    // Tagging by title collapses repeats: ten tool results should not become ten
    // notifications on a lock screen.
    const n = new Notification(title, { body, tag: title, silent: false });
    n.onclick = () => {
      try {
        window.focus();
        n.close();
      } catch {
        /* the tab may be gone */
      }
    };
  } catch {
    /* notification construction can throw on some mobile browsers */
  }
}

/** True when the page is not in front of the user — the only time a notification
 *  is worth showing. */
export function pageHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}
