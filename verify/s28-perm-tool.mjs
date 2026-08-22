// Verify (permission race + tool events over the wire): with a real server and two
// connected browsers, a permission.request reaches both; whichever side answers
// first resolves it and BOTH get permission.resolved (the browser card is then
// rewritten to the outcome — see s25's resolveApproval). Also: tool.end now carries
// the compact summary AND the full detail, and forwards to the browser. The DOM
// (amber→resolved card, the click-to-expand tool line) is browser-only; the store
// transform + grouping are covered in s25.
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const bus = new EventBus();
const bridge = createBridge(bus);
bridge.getAgents = () => [{ id: 1, name: "main", cwd: "/x", model: "m", mode: "ask", busy: false }];
const server = await startServer(bridge, { port: 0 });

function decode(buf, onText) { let o = 0; while (buf.length - o >= 2) { const op = buf[o] & 0x0f; let len = buf[o + 1] & 0x7f; let p = o + 2; if (len === 126) { if (buf.length - o < 4) break; len = buf.readUInt16BE(o + 2); p = o + 4; } else if (len === 127) { if (buf.length - o < 10) break; len = Number(buf.readBigUInt64BE(o + 2)); p = o + 10; } if (buf.length - p < len) break; if (op === 0x1) onText(buf.subarray(p, p + len).toString("utf8")); o = p + len; } return buf.subarray(o); }
function enc(str) { const pl = Buffer.from(str); const len = pl.length; const mask = crypto.randomBytes(4); let h; if (len < 126) h = Buffer.from([0x81, 0x80 | len]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); } const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = pl[i] ^ mask[i % 4]; return Buffer.concat([h, mask, out]); }
function connect() {
  return new Promise((resolve) => {
    const s = net.connect(server.port, "127.0.0.1", () => { const k = crypto.randomBytes(16).toString("base64"); s.write(`GET /ws?token=${server.token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`); });
    let buf = Buffer.alloc(0), up = false; const bl = [], w = [];
    const deliver = (o) => { const i = w.findIndex((x) => x.p(o)); if (i >= 0) { const [x] = w.splice(i, 1); x.d(o); } else bl.push(o); };
    const api = { send: (o) => s.write(enc(JSON.stringify(o))), waitFor: (p, ms = 2000) => new Promise((res, rej) => { const i = bl.findIndex(p); if (i >= 0) return res(bl.splice(i, 1)[0]); const t = setTimeout(() => rej(new Error("timeout")), ms); w.push({ p, d: (o) => { clearTimeout(t); res(o); } }); }), seen: (p) => bl.some(p), close: () => s.destroy() };
    s.on("data", (c) => { buf = Buffer.concat([buf, c]); if (!up) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; up = true; buf = buf.subarray(i + 4); resolve(api); } buf = decode(buf, (t) => { try { deliver(JSON.parse(t)); } catch {} }); });
  });
}

// Mirror the engine's permission coordination (first-to-answer wins).
function arm(id) {
  let done = false;
  const finish = (answer) => { if (done) return false; done = true; bridge.clearPermission(id); bus.emit({ type: "permission.resolved", tabId: 1, id, answer }); return true; };
  bridge.registerPermission(id, (a) => finish(a));
  bus.emit({ type: "permission.request", tabId: 1, id, preview: { kind: "diff", tool: "write", path: "greet.py" }, options: ["yes", "no", "always"] });
  return finish;
}

try {
  const a = await connect();
  const b = await connect();
  await a.waitFor((e) => e.type === "commands");
  await b.waitFor((e) => e.type === "commands");

  // Direction 1 — a BROWSER answers; both clients get the resolution.
  arm("1:1");
  await a.waitFor((e) => e.type === "permission.request" && e.id === "1:1");
  await b.waitFor((e) => e.type === "permission.request" && e.id === "1:1");
  a.send({ type: "permission", id: "1:1", answer: "yes" });
  const ra = await a.waitFor((e) => e.type === "permission.resolved" && e.id === "1:1");
  const rb = await b.waitFor((e) => e.type === "permission.resolved" && e.id === "1:1");
  ok("a browser approval resolves the card on the answering client", ra.answer === "yes");
  ok("...and on the other client too", rb.answer === "yes");

  // Direction 2 — the OTHER side (TUI) answers; both clients get the resolution.
  const finish2 = arm("1:2");
  await a.waitFor((e) => e.type === "permission.request" && e.id === "1:2");
  finish2("no"); // as if answered in the terminal
  const ra2 = await a.waitFor((e) => e.type === "permission.resolved" && e.id === "1:2");
  const rb2 = await b.waitFor((e) => e.type === "permission.resolved" && e.id === "1:2");
  ok("a TUI-side denial resolves the card in both browsers", ra2.answer === "no" && rb2.answer === "no");

  // First-to-answer wins — a late second answer is ignored (one resolved only).
  arm("1:3");
  await a.waitFor((e) => e.type === "permission.request" && e.id === "1:3");
  a.send({ type: "permission", id: "1:3", answer: "yes" });
  await a.waitFor((e) => e.type === "permission.resolved" && e.id === "1:3");
  b.send({ type: "permission", id: "1:3", answer: "no" }); // late
  await new Promise((r) => setTimeout(r, 80));
  const resolves = [];
  await b.waitFor((e) => { if (e.type === "permission.resolved" && e.id === "1:3") resolves.push(e); return false; }, 60).catch(() => {});
  ok("first answer wins — no second resolution for the same request", resolves.length <= 1);

  // tool.end forwards with BOTH the compact summary and the full detail.
  bus.emit({ type: "tool.end", tabId: 1, tool: "Write", primary: "greet.py", secondary: "", ok: true, summary: "Wrote 9 lines to greet.py", detail: "print('hi')\n" });
  const te = await a.waitFor((e) => e.type === "tool.end");
  ok("tool.end reaches the browser with the compact call parts + summary", te.tool === "Write" && te.primary === "greet.py" && te.summary.includes("Wrote 9 lines"));
  ok("tool.end carries the full detail for click-to-expand", te.detail === "print('hi')\n" && te.ok === true);

  a.close(); b.close();
} catch (e) { ok(`permission race + tool events completed (${e.message})`, false); }

await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
