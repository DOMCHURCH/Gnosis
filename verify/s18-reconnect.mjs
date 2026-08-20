// Verify (web UI phase 4 — reconnect replay): the server tags every event with a
// monotonic seq and keeps a ring buffer; a client that drops and reconnects with
// ?since=<lastSeq> replays exactly the events it missed — no gap, no duplicate of
// what it already saw, and no snapshot resend. A too-old `since` (beyond the
// buffer) resyncs agent state with a fresh snapshot first.
//
// The client-side auto-reconnect/backoff + the dark theme + the <900px collapse
// are browser concerns and are NOT covered here (see the commit note).
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

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bus = new EventBus();
const bridge = createBridge(bus);
bridge.getAgents = () => [{ id: 1, name: "main", cwd: "/x", model: "m", mode: "ask", busy: false }];
const server = await startServer(bridge, { port: 0 });

function decode(buf, onText) {
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - off < 4) break; len = buf.readUInt16BE(off + 2); p = off + 4; }
    else if (len === 127) { if (buf.length - off < 10) break; len = Number(buf.readBigUInt64BE(off + 2)); p = off + 10; }
    if (buf.length - p < len) break;
    if (opcode === 0x1) onText(buf.subarray(p, p + len).toString("utf8"));
    off = p + len;
  }
  return buf.subarray(off);
}
function wsConnect(token, since) {
  return new Promise((resolve) => {
    const q = `token=${token}${since != null ? `&since=${since}` : ""}`;
    const socket = net.connect(server.port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(`GET /ws?${q} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), up = false;
    const backlog = [], waiters = [];
    const deliver = (o) => { const i = waiters.findIndex((w) => w.pred(o)); if (i >= 0) { const [w] = waiters.splice(i, 1); w.done(o); } else backlog.push(o); };
    const api = {
      waitFor: (pred, ms = 2000) => new Promise((res, rej) => { const i = backlog.findIndex(pred); if (i >= 0) return res(backlog.splice(i, 1)[0]); const t = setTimeout(() => rej(new Error("timeout")), ms); waiters.push({ pred, done: (o) => { clearTimeout(t); res(o); } }); }),
      close: () => socket.destroy(),
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!up) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; if (!/ 101 /.test(buf.subarray(0, i).toString())) { resolve({ ok: false }); socket.destroy(); return; } up = true; buf = buf.subarray(i + 4); resolve({ ok: true, api }); }
      buf = decode(buf, (t) => { try { deliver(JSON.parse(t)); } catch {} });
    });
    socket.on("error", () => { if (!up) resolve({ ok: false }); });
  });
}

try {
  // --- fresh connect: snapshot + @sync ---------------------------------------
  const A = await wsConnect(server.token, null);
  const snap = await A.api.waitFor((e) => e.type === "agent.created");
  const sync1 = await A.api.waitFor((e) => e.type === "@sync");
  ok("fresh connect sends the agent snapshot + a @sync high-water mark", snap.name === "main" && typeof sync1.seq === "number");
  let lastSeq = sync1.seq;

  // live events carry increasing seq
  bus.emit({ type: "line", tabId: 1, item: { kind: "line", text: "one" } });
  bus.emit({ type: "line", tabId: 1, item: { kind: "line", text: "two" } });
  const e1 = await A.api.waitFor((e) => e.type === "line" && e.item.text === "one");
  const e2 = await A.api.waitFor((e) => e.type === "line" && e.item.text === "two");
  ok("live events carry a monotonically increasing seq", e1.seq === lastSeq + 1 && e2.seq === lastSeq + 2);
  lastSeq = e2.seq;

  // --- drop, emit while gone, reconnect with since ---------------------------
  A.api.close();
  await sleep(100);
  bus.emit({ type: "line", tabId: 1, item: { kind: "line", text: "missed-a" } });
  bus.emit({ type: "tool.end", tabId: 1, tool: "read", primary: "x", secondary: "", ok: true, summary: "readOK" });
  bus.emit({ type: "line", tabId: 1, item: { kind: "line", text: "missed-b" } });

  const B = await wsConnect(server.token, lastSeq);
  const replayed = [];
  for (;;) {
    const m = await B.api.waitFor(() => true);
    if (m.type === "@sync") break;
    replayed.push(m);
  }
  const texts = replayed.filter((m) => m.type === "line").map((m) => m.item.text);
  ok("reconnect replays exactly the missed line events, in order", JSON.stringify(texts) === JSON.stringify(["missed-a", "missed-b"]));
  ok("reconnect replays the missed tool event too", replayed.some((m) => m.type === "tool.end" && m.summary === "readOK"));
  ok("reconnect does NOT replay pre-disconnect events", !replayed.some((m) => m.type === "line" && (m.item.text === "one" || m.item.text === "two")));
  ok("reconnect does NOT resend the snapshot", !replayed.some((m) => m.type === "agent.created"));
  B.api.close();

  // --- too-old since (beyond the buffer) → snapshot resync -------------------
  // Overflow the 2000-entry ring so the oldest seq climbs above 1.
  for (let i = 0; i < 2100; i++) bus.emit({ type: "line", tabId: 1, item: { kind: "line", text: `flood${i}` } });
  const C = await wsConnect(server.token, 0); // since=0 is now far older than the buffer
  const first = await C.api.waitFor((e) => e.type === "agent.created" || e.type === "@sync");
  ok("a too-old since triggers a snapshot resync before replay", first.type === "agent.created");
  C.api.close();
} catch (e) {
  ok(`reconnect flow completed without timeout (${e.message})`, false);
}

await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
