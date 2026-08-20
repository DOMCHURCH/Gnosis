// Verify (web UI phase 2 — functional frontend): the browser↔server↔engine
// round-trips a browser depends on. A WS client acting as the browser: creates an
// agent, runs a turn that produces a tool call, answers a permission prompt, and
// closes an agent — each routing through the SAME bridge handlers App wires, with
// events flowing back. Also confirms the real React app bundled into dist/web.
//
// (The React rendering itself is covered by the successful `vite build` + the
// bundle smoke-check below; a live browser can't run in this offline harness.)
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- a bridge that stands in for the App/controller/engine ------------------
const bus = new EventBus();
const bridge = createBridge(bus);
let nextTab = 0;
const agents = new Map();
const spawn = (name) => {
  const id = ++nextTab;
  const a = { id, name: name || `tab${id}`, cwd: "/repo", model: "prov/model-x", mode: "ask", busy: false };
  agents.set(id, a);
  bus.emit({ type: "agent.created", tabId: id, name: a.name, cwd: a.cwd, model: a.model, mode: a.mode });
  return a;
};
let lastInput = null;
let lastCommand = null;
bridge.getAgents = () => [...agents.values()].map((a) => ({ ...a }));
bridge.onCreateAgent = (name) => spawn(name);
bridge.onCloseAgent = (tabId) => { if (agents.delete(tabId)) bus.emit({ type: "agent.closed", tabId, name: `tab${tabId}` }); };
bridge.onCommand = (tabId, command) => { lastCommand = { tabId, command }; };
bridge.onInput = (tabId, text) => {
  lastInput = { tabId, text };
  // Simulate a turn with a tool call (what the engine would emit).
  bus.emit({ type: "line", tabId, item: { kind: "user", text } });
  bus.emit({ type: "tool.start", tabId, tool: "read", args: { path: "x.ts" } });
  bus.emit({ type: "tool.end", tabId, tool: "read", primary: "x.ts", secondary: "", ok: true, summary: "read 10 lines" });
  bus.emit({ type: "turn.end", tabId, cost: 0.001, tokens: 100 });
};

spawn("main"); // a root agent exists before anyone connects
const server = await startServer(bridge, { port: 0 });

// --- minimal browser-like WS client (sends masked frames) -------------------
function encodeClient(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, out]);
}
function decodeServer(buf, onText) {
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
function browser(token) {
  return new Promise((resolve) => {
    const socket = net.connect(server.port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(`GET /ws?token=${token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let up = false;
    const backlog = [];
    const waiters = [];
    const deliver = (o) => {
      const i = waiters.findIndex((w) => w.pred(o));
      if (i >= 0) { const [w] = waiters.splice(i, 1); w.done(o); } else backlog.push(o);
    };
    const api = {
      send: (o) => socket.write(encodeClient(JSON.stringify(o))),
      waitFor: (pred, ms = 2000) =>
        new Promise((res, rej) => {
          const i = backlog.findIndex(pred);
          if (i >= 0) return res(backlog.splice(i, 1)[0]);
          const t = setTimeout(() => rej(new Error("timeout")), ms);
          waiters.push({ pred, done: (o) => { clearTimeout(t); res(o); } });
        }),
      close: () => socket.destroy(),
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!up) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        up = true;
        buf = buf.subarray(idx + 4);
        resolve(api);
      }
      buf = decodeServer(buf, (t) => { try { deliver(JSON.parse(t)); } catch {} });
    });
  });
}

const b = await browser(server.token);
try {
  // snapshot on connect
  const snap = await b.waitFor((e) => e.type === "agent.created" && e.name === "main");
  ok("browser receives the existing agent on connect", snap.tabId === 1);

  // create an agent from the browser
  b.send({ type: "agent.create", name: "worker" });
  const created = await b.waitFor((e) => e.type === "agent.created" && e.name === "worker");
  ok("browser can create an agent", created.tabId === 2 && agents.has(2));

  // run a turn with a tool call from the browser
  b.send({ type: "input", tabId: 1, text: "read x.ts" });
  const userLine = await b.waitFor((e) => e.type === "line" && e.item?.kind === "user");
  ok("browser input reaches the engine (onInput)", lastInput?.tabId === 1 && lastInput?.text === "read x.ts");
  ok("the user line comes back to the browser", userLine.item.text === "read x.ts");
  const toolStart = await b.waitFor((e) => e.type === "tool.start");
  ok("a tool.start reaches the browser", toolStart.tool === "read");
  const toolEnd = await b.waitFor((e) => e.type === "tool.end");
  ok("a tool.end (with summary) reaches the browser", toolEnd.tool === "read" && toolEnd.ok === true && /read 10 lines/.test(toolEnd.summary));

  // slash command routes to onCommand
  b.send({ type: "command", tabId: 1, command: "/cost" });
  await new Promise((r) => setTimeout(r, 50));
  ok("a slash command routes to onCommand", lastCommand?.command === "/cost");

  // approve a permission prompt from the browser
  let answered = null;
  const permId = "1:1";
  bridge.registerPermission(permId, (a) => { answered = a; });
  bus.emit({ type: "permission.request", tabId: 1, id: permId, preview: { kind: "bash", command: "npm test", dangerous: false, cwd: "/repo" }, options: ["yes", "no", "always"] });
  const req = await b.waitFor((e) => e.type === "permission.request");
  ok("permission.request reaches the browser with a preview", req.preview?.command === "npm test");
  b.send({ type: "permission", id: permId, answer: "yes" });
  await new Promise((r) => setTimeout(r, 50));
  ok("the browser can approve the permission (resolver got 'yes')", answered === "yes");

  // close an agent from the browser
  b.send({ type: "agent.close", tabId: 2 });
  const closed = await b.waitFor((e) => e.type === "agent.closed");
  ok("browser can close an agent", closed.tabId === 2 && !agents.has(2));
} catch (e) {
  ok(`round-trip completed without timeout (${e.message})`, false);
}

// --- the real React app bundled into dist/web -------------------------------
const webIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/web/index.html");
let html = "";
try { html = await fs.readFile(webIndex, "utf8"); } catch {}
ok("dist/web/index.html exists (vite build ran)", html.length > 1000);
ok("the bundle is a single self-contained file (JS inlined)", /<script/.test(html) && !/src=["']\.\/assets/.test(html));
ok("the bundle contains the real app (not the placeholder)", html.includes("new agent") && html.includes("approval needed"));

b.close();
await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
