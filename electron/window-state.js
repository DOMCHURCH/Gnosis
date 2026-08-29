// Window geometry and UI state that survives a restart.
//
// Two things live here, for one reason. The obvious one is window bounds. The
// less obvious one is renderer UI state (which panel tab was open, whether the
// terminal dock was up and how tall): the desktop app serves its page from an
// EPHEMERAL port, so the origin — and with it localStorage — is different on
// every launch. Anything the renderer remembers for itself is therefore already
// forgotten by the next start. Persisting that state out here, keyed to the app
// rather than to a port, is what makes it stick.

import Store from "electron-store";
import { screen } from "electron";

const store = new Store({
  name: "window-state",
  defaults: {
    bounds: { width: 1440, height: 900 },
    maximized: false,
    ui: {},
  },
});

const DEFAULTS = { width: 1440, height: 900 };
const MIN_VISIBLE = 80; // px of the window that must land on some display

/** Is this rectangle meaningfully on one of the currently attached displays? */
function isOnScreen(b) {
  if (!b || typeof b.x !== "number" || typeof b.y !== "number") return false;
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    // Require a real overlap, not a single shared pixel: a window restored to a
    // monitor that has since been unplugged otherwise comes back one pixel onto
    // the remaining screen, which is indistinguishable from lost.
    const overlapX = Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x);
    const overlapY = Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

/** Saved bounds, clamped to something usable, or a centred default. */
export function restoredBounds() {
  const saved = store.get("bounds");
  const b = {
    width: Math.max(900, Math.round(saved?.width ?? DEFAULTS.width)),
    height: Math.max(600, Math.round(saved?.height ?? DEFAULTS.height)),
  };
  if (saved && isOnScreen({ ...b, x: saved.x, y: saved.y })) {
    return { ...b, x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  // Off-screen (or never saved): let Electron centre it.
  return b;
}

export function wasMaximized() {
  return !!store.get("maximized");
}

/**
 * Track a window: persist bounds on move/resize and the maximized flag, and
 * re-apply maximize if that is how it was left.
 *
 * Writes are debounced — a drag fires `move` continuously and each write is a
 * synchronous JSON dump to disk.
 */
export function track(win) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    store.set("maximized", maximized);
    // Only record bounds while in a normal state: capturing them while
    // maximized or minimised would restore a window that can never be unmaximized
    // back to a useful size.
    if (!maximized && !win.isMinimized() && win.isVisible()) store.set("bounds", win.getBounds());
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  for (const ev of ["resize", "move"]) win.on(ev, schedule);
  for (const ev of ["maximize", "unmaximize"]) win.on(ev, save);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    save();
  });

  if (wasMaximized()) win.maximize();
}

/** Renderer-owned UI state (panel tab, dock open/height), as one opaque blob.
 * The shell does not interpret it; it only outlives the port the renderer is
 * served from. */
export function getUiState() {
  return store.get("ui") ?? {};
}

export function setUiState(patch) {
  if (!patch || typeof patch !== "object") return;
  store.set("ui", { ...(store.get("ui") ?? {}), ...patch });
}
