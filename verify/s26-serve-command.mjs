// Verify (/serve mechanism): the machinery `/serve` relies on — a plain session's
// controller starts with NO bus, then attachBus() wires the running engines and a
// real server started over that bridge shares the SAME bus. A browser connecting
// sees the existing agents and receives live events; a tab created after /serve
// also emits. The TUI keystroke path (typing `/serve`, the persistent line,
// reprint/stop) needs a live terminal and is NOT driven here — this covers the
// shared backend it calls into.
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");
const { TabsController } = await import("../dist/tabs.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const makeEngine = (cwd = "/proj") => ({ cwd, modelId: "m", mode: "ask", cost: { usd: 0 }, toolContext: undefined, messages: [], bus: undefined, bridge: undefined, agentId: 0, agentName: "", fork() { return makeEngine(cwd); }, abort() {} });

// A plain TUI session: controller with NO bus/bridge (as if launched as `dom`).
const controller = new TabsController(makeEngine(), "main", () => Promise.resolve(), () => {});
ok("a plain session starts with no bus attached to its engine", controller.active().engine.bus === undefined);

// `/serve` builds a bus + bridge, wires getAgents, and attaches to the live engines.
const bus = new EventBus();
const bridge = createBridge(bus);
bridge.getAgents = () => controller.tabs.map((t) => ({ id: t.id, name: t.name, cwd: t.engine.cwd, model: t.engine.modelId, mode: t.engine.mode, busy: t.busy }));
controller.attachBus(bus, bridge);
ok("attachBus wires the bus onto the already-running engine", controller.active().engine.bus === bus);
ok("attachBus wires the bridge too", controller.active().engine.bridge === bridge);

const server = await startServer(bridge, { port: 0 });

function decode(buf, onText) { let o = 0; while (buf.length - o >= 2) { const op = buf[o] & 0x0f; let len = buf[o + 1] & 0x7f; let p = o + 2; if (len === 126) { if (buf.length - o < 4) break; len = buf.readUInt16BE(o + 2); p = o + 4; } else if (len === 127) { if (buf.length - o < 10) break; len = Number(buf.readBigUInt64BE(o + 2)); p = o + 10; } if (buf.length - p < len) break; if (op === 0x1) onText(buf.subarray(p, p + len).toString("utf8")); o = p + len; } return buf.subarray(o); }
function enc(str) { const pl = Buffer.from(str); const len = pl.length; const mask = crypto.randomBytes(4); let h; if (len < 126) h = Buffer.from([0x81, 0x80 | len]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); } const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = pl[i] ^ mask[i % 4]; return Buffer.concat([h, mask, out]); }
function connect() {
  return new Promise((resolve) => {
    const s = net.connect(server.port, "127.0.0.1", () => { const k = crypto.randomBytes(16).toString("base64"); s.write(`GET /ws?token=${server.token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`); });
    let buf = Buffer.alloc(0), up = false; const bl = [], w = [];
    const deliver = (o) => { const i = w.findIndex((x) => x.p(o)); if (i >= 0) { const [x] = w.splice(i, 1); x.d(o); } else bl.push(o); };
    const api = { send: (o) => s.write(enc(JSON.stringify(o))), waitFor: (p, ms = 2000) => new Promise((res, rej) => { const i = bl.findIndex(p); if (i >= 0) return res(bl.splice(i, 1)[0]); const t = setTimeout(() => rej(new Error("timeout")), ms); w.push({ p, d: (o) => { clearTimeout(t); res(o); } }); }), close: () => s.destroy() };
    s.on("data", (c) => { buf = Buffer.concat([buf, c]); if (!up) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; up = true; buf = buf.subarray(i + 4); resolve(api); } buf = decode(buf, (t) => { try { deliver(JSON.parse(t)); } catch {} }); });
  });
}

try {
  const c = await connect();
  // The connecting browser sees the session that was ALREADY running.
  const snap = await c.waitFor((e) => e.type === "agent.created" && e.name === "main");
  ok("a connecting browser sees the already-running session", snap.tabId === controller.active().id && snap.cwd === "/proj");

  // Live events over the shared bus reach the browser (as they would once /serve is up).
  bus.emit({ type: "line", tabId: controller.active().id, item: { kind: "line", text: "hello from the session" } });
  const line = await c.waitFor((e) => e.type === "line");
  ok("live events on the shared bus reach the browser", line.item?.text === "hello from the session");

  // A tab created AFTER /serve also emits to the browser.
  controller.create("worker", "does work");
  const created = await c.waitFor((e) => e.type === "agent.created" && e.name === "worker");
  ok("a tab opened after /serve emits agent.created", !!created && controller.byName("worker").engine.bus === bus);

  c.close();
} catch (e) { ok(`/serve mechanism completed (${e.message})`, false); }

await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
