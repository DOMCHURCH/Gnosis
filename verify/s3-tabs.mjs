// Verify 3 (controller): separate histories, message-triggers-turn, and the three
// loop guards (hop limit, no-reply-to-sender, global cap) + badge-without-focus-steal.
import { TabsController, MAX_HOPS, MAX_MESSAGES } from "../dist/tabs.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) fails++; };
const tick = () => new Promise((r) => setTimeout(r, 15));

// A minimal stand-in for Engine — the controller only forks it, aborts it, and
// reads .cwd / sets .toolContext.
const makeEngine = () => ({ cwd: process.cwd(), toolContext: undefined, messages: [], fork() { return makeEngine(); }, abort() {} });

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

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
