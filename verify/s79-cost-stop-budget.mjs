// Verify (live spend, stop, sub-agent budgets): the running cost readout updates
// per model call instead of once a turn ends, the browser can interrupt a turn,
// and the coordinator sizes each sub-agent's token budget — asking the user before
// removing the limit entirely.
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");
const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");
const mkSession = () => createSession(process.cwd(), "m", "ask");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- cost.update is emitted per model call, not once per turn -----------------
const bus = new EventBus();
const seen = [];
bus.subscribe((e) => seen.push(e));
const eng = new Engine({ apiKey: "k", cwd: process.cwd(), systemPrompt: "s", models: [], session: mkSession(), skills: [] });
eng.bus = bus;
eng.agentId = 7;
eng.cost.promptTokens = 1200;
eng.cost.completionTokens = 300;
eng.cost.cachedPromptTokens = 100;
eng.cost.usd = 0.0042;
eng.emitCost();
const upd = seen.filter((e) => e.type === "cost.update");
ok("the engine emits cost.update", upd.length === 1);
ok("...for its own tab", upd[0].tabId === 7);
ok("...carrying ABSOLUTE totals, not a delta", upd[0].tokens === 1500 && upd[0].cost === 0.0042);
ok("...including cached tokens", upd[0].cachedTokens === 100);

eng.cost.completionTokens = 900;
eng.emitCost();
const upd2 = seen.filter((e) => e.type === "cost.update");
ok("a second call reports the new running total", upd2[1].tokens === 2100);

// --- sub-agent token budgets --------------------------------------------------
// resolveSubBudget is private; drive it through the public tool context the model
// actually calls, with runSubAgent stubbed so nothing hits the network.
function budgetProbe(engine) {
  const applied = [];
  engine.runSubAgent = async (_d, _p, _s, opts) => { applied.push(opts?.tokenBudget); return { text: "x", tools: 0, tokens: 0, capped: null }; };
  return applied;
}

const e2 = new Engine({ apiKey: "k", cwd: process.cwd(), systemPrompt: "s", models: [], session: mkSession(), skills: [] });
const applied = budgetProbe(e2);
const ctx = e2.toolCtx ? e2.toolCtx() : null;
ok("the engine exposes a tool context", !!ctx && typeof ctx.subagent === "function");

await ctx.subagent("lookup", "p", undefined, undefined);
ok("no request → the default budget", applied[0] === 32_000);

await ctx.subagent("big draft", "p", undefined, { tokenBudget: 90_000 });
ok("the coordinator's own figure is honoured", applied[1] === 90_000);

await ctx.subagent("tiny", "p", undefined, { tokenBudget: 10 });
ok("an absurdly small budget clamps up to the floor", applied[2] === 4_000);

await ctx.subagent("huge", "p", undefined, { tokenBudget: 5_000_000 });
ok("a budget past the ceiling clamps down", applied[3] === 200_000);

// tokenBudget: 0 = "remove the limit" — must ask, and must NOT uncap unasked.
await ctx.subagent("unbounded", "p", undefined, { tokenBudget: 0 });
ok("with nobody to ask, removing the limit is DECLINED (ceiling, not Infinity)", applied[4] === 200_000);

// Now with a user to ask.
const asked = [];
e2.setAskUser?.((q, o) => { asked.push({ q, o }); return Promise.resolve("Remove the limit"); });
if (!e2.setAskUser) e2.askUserFn = (q, o) => { asked.push({ q, o }); return Promise.resolve("Remove the limit"); };
const ctx2 = e2.toolCtx();
await ctx2.subagent("unbounded", "p", undefined, { tokenBudget: 0 });
ok("removing the limit asks the user", asked.length === 1);
ok("...naming the sub-agent in the question", asked.length === 1 && asked[0].q.includes("unbounded"));
ok("...offering a keep-the-cap option", asked.length === 1 && asked[0].o.length === 2);
ok("...and an approval actually uncaps", applied[5] === Infinity);

asked.length = 0;
e2.askUserFn = (q, o) => { asked.push({ q, o }); return Promise.resolve(o[1]); };
const ctx3 = e2.toolCtx();
await ctx3.subagent("unbounded", "p", undefined, { tokenBudget: 0 });
ok("a decline falls back to the ceiling, never Infinity", applied[6] === 200_000);

// A coordinated fan-out asks ONCE, not once per subtask.
asked.length = 0;
const e3 = new Engine({ apiKey: "k", cwd: process.cwd(), systemPrompt: "s", models: [], session: mkSession(), skills: [] });
const applied3 = budgetProbe(e3);
e3.askUserFn = (q, o) => { asked.push({ q, o }); return Promise.resolve(o[1]); };
await e3.runCoordinatedTask(
  [{ description: "a", prompt: "p" }, { description: "b", prompt: "p", tokenBudget: 50_000 }, { description: "c", prompt: "p" }],
  undefined,
  { tokenBudget: 0 },
);
ok("a fan-out asks the user exactly once", asked.length === 1);
ok("a subtask's own budget overrides the fan-out default", applied3[1] === 50_000);
ok("the others take the declined fallback", applied3[0] === 200_000 && applied3[2] === 200_000);

// --- agent.stop reaches the bridge --------------------------------------------
const bridge = createBridge(new EventBus());
bridge.getAgents = () => [{ id: 1, name: "main", cwd: "/x", model: "m", mode: "ask", busy: true, imageInput: false, documentInput: false, contextLimit: 0, tokens: 0, cost: 0 }];
let stopped = null;
bridge.onStopAgent = (id) => { stopped = id; };
const server = await startServer(bridge, { port: 0 });

function send(sock, text) {
  const b = Buffer.from(text), mask = crypto.randomBytes(4);
  let head;
  if (b.length < 126) head = Buffer.from([0x81, 0x80 | b.length]);
  else { const x = Buffer.alloc(2); x.writeUInt16BE(b.length); head = Buffer.concat([Buffer.from([0x81, 0xfe]), x]); }
  const m2 = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i++) m2[i] = b[i] ^ mask[i % 4];
  sock.write(Buffer.concat([head, mask, m2]));
}
const sock = net.connect(server.port, "127.0.0.1");
await new Promise((res) => {
  let up = false, buf = Buffer.alloc(0);
  sock.on("connect", () => sock.write(
    `GET /ws?token=${server.token} HTTP/1.1\r\nHost: localhost:${server.port}\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  sock.on("data", (c) => { buf = Buffer.concat([buf, c]); if (!up && buf.indexOf("\r\n\r\n") !== -1) { up = true; res(); } });
});
send(sock, JSON.stringify({ type: "agent.stop", tabId: 1 }));
await new Promise((r) => setTimeout(r, 300));
ok("agent.stop from the browser reaches onStopAgent", stopped === 1);
ok("...with the right tab", stopped === 1);

sock.destroy();
await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
