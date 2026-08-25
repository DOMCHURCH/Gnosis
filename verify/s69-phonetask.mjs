// Verify (phone task assignment): the three modes map to the right actions, and
// the notification helper stays quiet rather than throwing when the browser has
// not granted (or does not have) permission.
import { canNotify, notify, requestNotifyPermission, pageHidden } from "../web/src/notify.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- no Notification API at all (Node, and older mobile browsers) --------------
delete globalThis.window;
delete globalThis.Notification;
ok("canNotify is false without the API", canNotify() === false);
ok("notify is a silent no-op, not a throw", (() => { try { notify("t", "b"); return true; } catch { return false; } })());
ok("requesting permission resolves false rather than throwing", (await requestNotifyPermission()) === false);
ok("pageHidden is false with no document", pageHidden() === false);

// --- permission denied ---------------------------------------------------------
{
  let constructed = 0;
  globalThis.window = {};
  globalThis.Notification = function () { constructed++; };
  globalThis.Notification.permission = "denied";
  globalThis.Notification.requestPermission = async () => "denied";
  globalThis.window.Notification = globalThis.Notification;

  ok("canNotify is true when the API exists", canNotify() === true);
  ok("a denied permission is not re-requested", (await requestNotifyPermission()) === false);
  notify("t", "b");
  ok("...and nothing is shown", constructed === 0);
}

// --- permission granted ----------------------------------------------------------
{
  const shown = [];
  globalThis.Notification = function (title, opts) { shown.push({ title, ...opts }); };
  globalThis.Notification.permission = "granted";
  globalThis.Notification.requestPermission = async () => "granted";
  globalThis.window.Notification = globalThis.Notification;

  ok("a granted permission short-circuits the prompt", (await requestNotifyPermission()) === true);
  notify("Gnosis · dream d1 done", "deleted the scratch dir");
  ok("a notification is shown", shown.length === 1);
  ok("...with the title", shown[0].title === "Gnosis · dream d1 done");
  ok("...and the body", shown[0].body === "deleted the scratch dir");
  // Repeats on a lock screen are noise; tagging collapses them.
  ok("...tagged so repeats collapse", shown[0].tag === "Gnosis · dream d1 done");
}

// --- page visibility gates the 'needs you' notifications --------------------------
{
  globalThis.document = { visibilityState: "visible" };
  ok("a visible page is not hidden", pageHidden() === false);
  globalThis.document = { visibilityState: "hidden" };
  ok("a backgrounded page is hidden", pageHidden() === true);
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
