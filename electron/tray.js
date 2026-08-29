// System tray: a live status light for the agent, plus the way back to a window
// that has been closed to the tray.
//
// State comes from the SAME event bus the web UI renders from — `agent.busy` is
// what the roster uses to show an agent working, so the tray and the UI can never
// disagree about whether something is running. "listening" is not derived from the
// bus: it is voice mode's, set explicitly via setListening() when that lands.

import { Tray, Menu, app } from "electron";
import { trayIcon } from "./tray-icon.js";

const LABEL = {
  idle: "Idle",
  active: "Working",
  listening: "Listening",
};

/**
 * @param bus     the AppBridge event bus
 * @param onShow  bring the window back (created/focused by the caller)
 * @param onQuit  real quit, not hide
 */
export function createTray(bus, { onShow, onSettings, onQuit }) {
  const tray = new Tray(trayIcon("idle"));

  // Busy is per-agent and agents overlap, so track the set rather than a single
  // flag — one agent finishing must not blank the light while another still runs.
  const busy = new Set();
  let listening = false;
  let state = "idle";

  const render = () => {
    const next = listening ? "listening" : busy.size ? "active" : "idle";
    if (next !== state) {
      state = next;
      tray.setImage(trayIcon(state));
    }
    const detail = state === "active" ? `${LABEL.active} · ${busy.size} agent${busy.size === 1 ? "" : "s"}` : LABEL[state];
    tray.setToolTip(`Gnosis — ${detail}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Gnosis — ${detail}`, enabled: false },
        { type: "separator" },
        { label: "Show Gnosis", click: () => onShow() },
        { label: "Settings…", click: () => onSettings?.() },
        { type: "separator" },
        { label: "Quit Gnosis", click: () => onQuit() },
      ]),
    );
  };
  render();

  // Clicking the icon is the fast path back to the window; the menu is the slow one.
  tray.on("click", () => onShow());

  // bus is null when boot() failed: the window is showing the error page, there
  // is no agent to report on, but the tray must still exist so the user can quit.
  const unsub = bus?.subscribe((e) => {
    if (e.type === "agent.busy") {
      if (e.busy) busy.add(e.tabId);
      else busy.delete(e.tabId);
      render();
    } else if (e.type === "agent.closed") {
      // A tab closed mid-turn never emits busy:false — without this the light
      // would stay on for an agent that no longer exists.
      if (busy.delete(e.tabId)) render();
    }
  });

  return {
    /** Voice mode's hook. Nothing calls this until voice lands. */
    setListening(on) {
      if (listening === on) return;
      listening = on;
      render();
    },
    /** Current state — exposed so it can be asserted in tests. */
    get state() {
      return state;
    },
    destroy() {
      unsub?.();
      tray.destroy();
    },
  };
}
