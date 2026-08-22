// Verify (interactive-overlay round-trip): an `overlay.open` emitted on the bus is
// forwarded to a connected web client, and the client's `overlay.select` /
// `overlay.cancel` route back through bridge.answerOverlay to the registered
// resolver. Also checks first-to-answer (a second answer is ignored) and that a
// cleared overlay has no orphaned pending. The browser modal (filter/arrows) is
// browser-only and NOT covered here — this is the wire contract the TUI shares.
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
    const api = { send: (o) => s.write(enc(JSON.stringify(o))), waitFor: (p, ms = 2000) => new Promise((res, rej) => { const i = bl.findIndex(p); if (i >= 0) return res(bl.splice(i, 1)[0]); const t = setTimeout(() => rej(new Error("timeout")), ms); w.push({ p, d: (o) => { clearTimeout(t); res(o); } }); }), close: () => s.destroy() };
    s.on("data", (c) => { buf = Buffer.concat([buf, c]); if (!up) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; up = true; buf = buf.subarray(i + 4); resolve(api); } buf = decode(buf, (t) => { try { deliver(JSON.parse(t)); } catch {} }); });
  });
}

// Model the App.tsx first-to-answer coordination at the bridge level: register a
// resolver with a one-shot `settle`, emit overlay.open, and let either the web
// (bridge.answerOverlay) or the "TUI" (direct call) resolve first.
function arm(id, pick) {
  let done = false;
  const settle = () => { if (done) return false; done = true; bridge.clearOverlay(id); bus.emit({ type: "overlay.resolved", id }); return true; };
  bridge.registerOverlay(id, (v) => { if (settle() && v !== null) pick(v); });
  bus.emit({ type: "overlay.open", tabId: 1, id, kind: "model", title: "select model", items: [{ value: "a/x", label: "a/x" }, { value: "b/y", label: "b/y" }], selected: "a/x" });
  return settle;
}

try {
  const c = await connect();
  await c.waitFor((e) => e.type === "commands"); // drain connect frames

  // 1) overlay.open is forwarded to the client with its list + selection.
  let picked = null;
  arm("overlay:1:1", (v) => { picked = v; });
  const open = await c.waitFor((e) => e.type === "overlay.open");
  ok("overlay.open reaches the web client", open.id === "overlay:1:1" && open.kind === "model" && open.title === "select model");
  ok("overlay.open carries the item list + current selection", Array.isArray(open.items) && open.items.length === 2 && open.selected === "a/x");

  // 2) client overlay.select routes back to the registered resolver + echoes resolved.
  c.send({ type: "overlay.select", id: "overlay:1:1", value: "b/y" });
  const resolved = await c.waitFor((e) => e.type === "overlay.resolved");
  ok("overlay.select runs the shared pick action", picked === "b/y");
  ok("resolving echoes overlay.resolved to close the other client", resolved.id === "overlay:1:1");

  // 3) first-to-answer: a second answer (or a late TUI settle) is ignored.
  picked = null;
  const settle2 = arm("overlay:1:2", (v) => { picked = v; });
  await c.waitFor((e) => e.type === "overlay.open" && e.id === "overlay:1:2");
  const tuiWon = settle2(); // the "TUI" resolves first (e.g. Esc/select in the terminal)
  c.send({ type: "overlay.select", id: "overlay:1:2", value: "a/x" }); // web answers late
  await new Promise((r) => setTimeout(r, 60));
  ok("first answer wins — a late web select is ignored", tuiWon === true && picked === null);

  // 4) cancel path: overlay.cancel resolves with null (no pick), still closes.
  let cancelPicked = "untouched";
  arm("overlay:1:3", (v) => { cancelPicked = v; });
  await c.waitFor((e) => e.type === "overlay.open" && e.id === "overlay:1:3");
  c.send({ type: "overlay.cancel", id: "overlay:1:3" });
  const cres = await c.waitFor((e) => e.type === "overlay.resolved" && e.id === "overlay:1:3");
  ok("overlay.cancel resolves without running pick", cancelPicked === "untouched" && cres.id === "overlay:1:3");

  // 5) no orphaned pending: answering a cleared/unknown overlay does nothing.
  let orphan = false;
  bridge.registerOverlay("overlay:gone", () => { orphan = true; });
  bridge.clearOverlay("overlay:gone");
  bridge.answerOverlay("overlay:gone", "a/x");
  bridge.answerOverlay("overlay:never", "a/x");
  ok("a cleared/unknown overlay has no orphaned resolver", orphan === false);

  c.close();
} catch (e) { ok(`overlay round-trip completed (${e.message})`, false); }

await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
