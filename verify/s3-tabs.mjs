// Verify 3 (controller): separate histories, message-triggers-turn, and the three
// loop guards (hop limit, no-reply-to-sender, global cap) + badge-without-focus-steal.
import { TabsController, MAX_HOPS, MAX_MESSAGES, MAX_TABS } from "../dist/tabs.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) fails++; };
const tick = () => new Promise((r) => setTimeout(r, 15));

// A minimal stand-in for Engine — the controller only forks it, aborts it, and
// reads .cwd / sets .toolContext.
const makeEngine = (cwd = process.cwd()) => ({ cwd, toolContext: undefined, messages: [], fork(opts) { return makeEngine(opts?.cwd ?? cwd); }, abort() {} });

const runs = [];
const executor = (tab, text) => { runs.push({ name: tab.name, text }); return Promise.resolve(); };
const controller = new TabsController(makeEngine(), "main", executor, () => {});

// --- constants match the spec ---
ok("MAX_HOPS is 3", MAX_HOPS === 3);
ok("MAX_MESSAGES is 20", MAX_MESSAGES === 20);

// --- three tabs, separate Engines & histories ---
controller.create("worker", "does work");
controller.create("other", "does other things");
ok("three tabs open", controller.tabs.length === 3);
const main = controller.byName("main"), worker = controller.byName("worker"), other = controller.byName("other");
ok("each tab has a distinct Engine", main.engine !== worker.engine && worker.engine !== other.engine);
main.engine.messages.push("m1"); worker.engine.messages.push("w1"); worker.engine.messages.push("w2");
ok("histories are independent", main.engine.messages.length === 1 && worker.engine.messages.length === 2 && other.engine.messages.length === 0);

// --- a message from one tab triggers a turn in the target ---
const r1 = controller.route("main", "worker", "hello");
ok("route main→worker accepted", r1.ok);
await tick();
const workerRun = runs.find((r) => r.name === "worker");
ok("worker actually ran a turn from the message", !!workerRun);
ok("delivered message is tagged with the sender", workerRun?.text.includes("[message from main]") && workerRun.text.includes("hello"));
await tick();

// --- guard 1: hop limit (reject ABOVE 3 hops) ---
worker.currentHops = 2; worker.currentSender = null;
const hop3 = controller.route("worker", "other", "ping"); // from hops 2 → hop 3
ok("hop 3 is allowed", hop3.ok && /hop 3/.test(hop3.message));
await tick();
worker.currentHops = 3; worker.currentSender = null;
const hop4 = controller.route("worker", "other", "ping"); // from hops 3 → hop 4
ok("hop 4 is rejected (over the 3-hop limit)", !hop4.ok && /hop 4/.test(hop4.message) && /limit|Loop stopped/i.test(hop4.message));
worker.currentHops = 0;

// --- guard 2: a tab may not reply to the tab a message just arrived from ---
worker.currentSender = "main"; worker.currentHops = 1;
const reply = controller.route("worker", "main", "immediate reply");
ok("reply to the just-received sender is rejected", !reply.ok && /cannot reply/i.test(reply.message));
const sideways = controller.route("worker", "other", "ok to a third tab");
ok("messaging a different tab in the same turn is allowed", sideways.ok);
worker.currentSender = null; worker.currentHops = 0;
await tick();

// --- guard 3: global per-session cap ---
const saved = controller.messageCount;
controller.messageCount = MAX_MESSAGES;
const capped = controller.route("main", "worker", "over cap");
ok("routing past the global cap is a hard stop", !capped.ok && /cap/i.test(capped.message));
controller.messageCount = saved;

// --- createTab (office mode=real) obeys the SAME loop guards as route() —
// it is the one path a whole-office fill uses to spawn real, fully-capable
// tabs, and previously bypassed hops, messageCount, and had no tab-count
// ceiling at all. ---
{
  const c3 = new TabsController(makeEngine(), "main", executor, () => {});
  const rootTab = c3.active();
  const rt = rootTab.engine.toolContext.tab;

  const r1 = rt.createTab("w1", "", "do a thing");
  ok("createTab: a normal call from hop 0 succeeds", r1.ok);
  ok("...and spends the shared message budget for it", c3.messageCount === 1);

  // hop limit: a creator already at the limit must be refused, not reset to hop 1
  rootTab.currentHops = MAX_HOPS;
  const rHop = rt.createTab("wHop", "", "task");
  ok("createTab: refuses when the creator is already at the hop limit", !rHop.ok && /hop/i.test(rHop.message));
  ok("...and does NOT create the tab", !c3.byName("wHop"));
  rootTab.currentHops = 0;

  // message cap: exhaust it, then confirm createTab-with-task is refused too
  c3.messageCount = MAX_MESSAGES;
  const rCap = rt.createTab("wCap", "", "task");
  ok("createTab: refuses past the global message cap, same as route()", !rCap.ok && /cap/i.test(rCap.message));
  ok("...and does NOT create the tab", !c3.byName("wCap"));
  c3.messageCount = 0;

  // a task-less createTab doesn't touch hops/messageCount (nothing is dispatched)
  const rBare = rt.createTab("wBare", "", undefined);
  ok("createTab: a task-less call still opens an idle tab", rBare.ok && !!c3.byName("wBare"));
  ok("...without spending the message budget", c3.messageCount === 0);
  c3.close(c3.byName("wBare").id);

  // tab-count ceiling: nothing capped total tabs before this fix
  while (c3.tabs.length < MAX_TABS) rt.createTab(undefined, "", undefined);
  ok(`createTab: reaches the ${MAX_TABS}-tab ceiling`, c3.tabs.length === MAX_TABS);
  const before = c3.tabs.length;
  const rFull = rt.createTab("overflow", "", undefined);
  ok("createTab: refuses once the tab-count cap is reached", !rFull.ok && /cap/i.test(rFull.message));
  ok("...and does NOT create the tab", c3.tabs.length === before);
}

// --- self / unknown target ---
ok("a tab cannot message itself", !controller.route("main", "main", "x").ok);
ok("messaging an unknown tab errors", !controller.route("main", "ghost", "x").ok);

// --- badge without stealing focus; switching reveals the parked prompt ---
controller.markOutput(worker);
ok("background output badges the tab", worker.badge === "output");
ok("...without changing the active tab", controller.activeId === main.id);
let parkedResolved = null;
controller.setPendingPermission(worker, { preview: { kind: "http", method: "POST", url: "https://x", dangerous: true }, resolve: (a) => { parkedResolved = a; } });
ok("a background approval badges amber ('approval')", worker.badge === "approval");
ok("a background approval does NOT steal focus", controller.activeId === main.id);
controller.setActive(worker.id);
ok("switching to the tab clears its badge", worker.badge === "none" && controller.activeId === worker.id);
const pp = controller.takePendingPermission(worker);
ok("switching surfaces the parked permission prompt", pp && pp.preview.kind === "http");
controller.setActive(main.id);

// --- closing refuses to drop the last tab ---
controller.close(worker.id); controller.close(other.id);
const lastId = controller.active().id;
controller.close(lastId);
ok("close refuses to remove the final tab", controller.tabs.length === 1);

// --- named sessions: a nameless /new defaults to the cwd basename, not a number ---
{
  const c2 = new TabsController(makeEngine("/home/u/myproj"), "myproj", () => Promise.resolve(), () => {});
  ok("the root tab is named after its cwd basename", c2.active().name === "myproj");
  const a = c2.create(undefined, "", "/home/u/widgets");
  ok("a nameless new session defaults to its cwd basename", a.name === "widgets");
  const b = c2.create(undefined, "", "/home/u/widgets");
  ok("a second nameless session in the same dir gets a unique suffix", b.name === "widgets2");
  const named = c2.create("api", "", "/home/u/widgets");
  ok("an explicit name is still honoured", named.name === "api");
  ok("no session name is a bare number", c2.tabs.every((t) => !/^\d+$/.test(t.name)));
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
