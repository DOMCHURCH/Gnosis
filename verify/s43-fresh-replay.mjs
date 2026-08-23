// Verify (fresh-connect transcript replay): a client that connects WITHOUT a
// ?since (a first load or a page reload, where it has no lastSeq) must receive the
// buffered event history, not just the agent roster — otherwise every tab's chat
// rail is empty and switching floors shows identical (empty) content while only
// the header/roster updates. This is the root cause of the "same transcript on
// every session" bug. Runs the real server (startServer) over a raw WS client.
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

const bus = new EventBus();
const bridge = createBridge(bus);
bridge.getAgents = () => [
  { id: 1, name: "ALPHA", cwd: "/a", model: "m", mode: "ask", busy: false, imageInput: false, documentInput: false },
  { id: 2, name: "BRAVO", cwd: "/b", model: "m", mode: "ask", busy: false, imageInput: false, documentInput: false },
];
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
function wsConnect(token) {
  return new Promise((resolve) => {
    const socket = net.connect(server.port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(`GET /ws?token=${token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), up = false;
    const events = [];
    const waiters = [];
    const deliver = (o) => { events.push(o); const i = waiters.findIndex((w) => w.pred(o)); if (i >= 0) { const [w] = waiters.splice(i, 1); w.done(o); } };
    const api = {
      all: events,
      waitFor: (pred, ms = 2000) => new Promise((res, rej) => { const found = events.find(pred); if (found) return res(found); const t = setTimeout(() => rej(new Error("timeout")), ms); waiters.push({ pred, done: (o) => { clearTimeout(t); res(o); } }); }),
      close: () => socket.destroy(),
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!up) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; up = true; buf = buf.subarray(i + 4); resolve(api); }
      buf = decode(buf, (t) => { try { deliver(JSON.parse(t)); } catch {} });
    });
    socket.on("error", () => {});
  });
}

try {
  // Two tabs hold DISTINCT conversations before any browser connects.
  bus.emit({ type: "line", tabId: 1, item: { kind: "user", text: "hello from ALPHA" } });
  bus.emit({ type: "line", tabId: 1, item: { kind: "line", text: "alpha reply" } });
  bus.emit({ type: "line", tabId: 2, item: { kind: "user", text: "hello from BRAVO" } });
  bus.emit({ type: "tool.end", tabId: 2, tool: "read", primary: "x.ts", secondary: "", ok: true, summary: "read 10 lines" });

  // A FRESH connect (no ?since) — the page-reload case.
  const c = await wsConnect(server.token);
  await c.waitFor((e) => e.type === "@sync");

  const lines = c.all.filter((e) => e.type === "line");
  const tab1 = lines.filter((e) => e.tabId === 1).map((e) => e.item.text);
  const tab2 = lines.filter((e) => e.tabId === 2).map((e) => e.item.text);
  ok("fresh connect still sends the agent roster", c.all.some((e) => e.type === "agent.created" && e.name === "ALPHA") && c.all.some((e) => e.type === "agent.created" && e.name === "BRAVO"));
  ok("fresh connect replays tab 1's transcript", JSON.stringify(tab1) === JSON.stringify(["hello from ALPHA", "alpha reply"]));
  ok("fresh connect replays tab 2's transcript", JSON.stringify(tab2) === JSON.stringify(["hello from BRAVO"]));
  ok("fresh connect replays tab 2's tool event too", c.all.some((e) => e.type === "tool.end" && e.tabId === 2 && e.summary === "read 10 lines"));
  ok("the two tabs' replayed transcripts are DISTINCT (not shared)", JSON.stringify(tab1) !== JSON.stringify(tab2));
  c.close();
} catch (e) {
  ok(`fresh-replay flow completed without timeout (${e.message})`, false);
}

await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
