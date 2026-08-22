// Verify (web autocomplete wiring): on connect the server sends the slash-command
// registry (the SAME one the TUI uses, via bridge.getCommands), and a client
// {type:"files",query} request gets a ranked file list back (bridge.onFiles). The
// dropdown UI + arrow-key selection are browser-only and NOT covered here.
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");
const { COMMANDS } = await import("../dist/commands.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const bus = new EventBus();
const bridge = createBridge(bus);
bridge.getAgents = () => [{ id: 1, name: "main", cwd: "/x", model: "m", mode: "ask", busy: false }];
bridge.onFiles = async (_tabId, query) => ["src/engine.ts", "src/server.ts", "README.md"].filter((f) => f.includes(query));
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
  const cmds = await c.waitFor((e) => e.type === "commands");
  ok("server sends the command registry on connect", Array.isArray(cmds.list) && cmds.list.length === COMMANDS.length);
  ok("the list is the SAME registry the TUI uses (/model present)", cmds.list.some((x) => x.name === "/model") && cmds.list.some((x) => x.name === "/help"));

  c.send({ type: "files", tabId: 1, query: "server", reqId: 7 });
  const files = await c.waitFor((e) => e.type === "files");
  ok("a files request gets a response with the right reqId", files.reqId === 7);
  ok("the file list is ranked/filtered by query", files.list.includes("src/server.ts") && !files.list.includes("README.md"));
  c.close();
} catch (e) { ok(`autocomplete wiring completed (${e.message})`, false); }

await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
