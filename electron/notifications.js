// Native Windows toasts for the two things worth interrupting someone over: an
// agent that is blocked waiting for approval, and a turn that has finished.
//
// Fired ONLY when no Gnosis window has focus. A toast for something the user is
// already looking at is pure noise, and the approval prompt is already on screen
// in that case.
//
// Source is the same event bus the UI renders from, so a notification can never
// describe a state the window disagrees with.

import { Notification, BrowserWindow } from "electron";

/** Windows toasts truncate hard; a long preview just becomes an ellipsis. */
function clip(text, max = 90) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Pull something human out of a permission preview, whose shape varies by tool. */
function previewText(preview) {
  if (!preview) return "";
  if (typeof preview === "string") return preview;
  if (typeof preview === "object") {
    for (const k of ["summary", "title", "command", "path", "text", "description"]) {
      if (typeof preview[k] === "string" && preview[k]) return preview[k];
    }
  }
  return "";
}

/**
 * @param bus       the AppBridge event bus (null when boot failed)
 * @param onActivate  called when a toast is clicked, with { tabId, kind }
 */
export function registerNotifications(bus, { onActivate }) {
  if (!bus || !Notification.isSupported()) return () => {};

  const focused = () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());

  const fire = (title, body, payload) => {
    if (focused()) return; // the user is already here
    const n = new Notification({ title, body, silent: false });
    n.on("click", () => onActivate(payload));
    n.show();
  };

  // Agent names, so a toast can say which one wants you.
  const names = new Map();

  const unsub = bus.subscribe((e) => {
    try {
      if (e.type === "agent.created") names.set(e.tabId, e.name);
      else if (e.type === "agent.closed") names.delete(e.tabId);
      else if (e.type === "permission.request") {
        const who = names.get(e.tabId) ?? "agent";
        fire(
          "Gnosis — approval required",
          clip(previewText(e.preview) || `${who} is waiting on you`),
          { tabId: e.tabId, kind: "permission", id: e.id },
        );
      } else if (e.type === "turn.outcome") {
        // turn.outcome carries a one-line summary and a verdict, which is a far
        // better notification than turn.end's raw token counts.
        const who = names.get(e.tabId) ?? "agent";
        const verdict = e.verdict === "fail" ? "needs attention" : "done";
        fire(`Gnosis — ${verdict}: ${who}`, clip(e.summary || e.line || ""), { tabId: e.tabId, kind: "turn" });
      }
    } catch {
      // A notification must never be able to break the bus for everyone else.
    }
  });
  return unsub;
}
