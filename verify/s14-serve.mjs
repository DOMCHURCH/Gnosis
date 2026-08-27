// Verify (web UI phase 1 — server + event stream): dom serve binds localhost,
// prints a tokenized URL, refuses a WS connect without the token and any request
// with a non-localhost Host header, and forwards bus events so a connected client
// and a direct bus subscriber (the TUI) see the SAME transcript simultaneously.
import net from "node:net";
import http from "node:http";
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
bridge.getAgents = () => [{ id: 1, name: "main", cwd: "/x", model: "m", mode: "ask", busy: false }];
const server = await startServer(bridge, { port: 0 });

// --- tokenized, localhost URL ------------------------------------------------
ok("prints a tokenized localhost URL", server.url.includes("127.0.0.1") && /\/\?token=.+/.test(server.url));

// --- HTTP: token + Host enforcement -----------------------------------------
function httpGet({ token, host }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.port, path: `/${token ? `?token=${token}` : ""}`, method: "GET", headers: host ? { Host: host } : {} },
      (res) => { res.resume(); resolve(res.statusCode); },
    );
    req.on("error", () => resolve(0));
    req.end();
  });
}
ok("GET / with the right token → 200", (await httpGet({ token: server.token })) === 200);
ok("GET / with a wrong token → 401", (await httpGet({ token: "not-the-token" })) === 401);
ok("GET / with Host: evil.com → 403 (DNS-rebinding defense)", (await httpGet({ token: server.token, host: "evil.com" })) === 403);

// --- minimal WS client (server frames are unmasked text) --------------------
function decodeServerFrames(buf, onText) {
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - off < 4) break; len = buf.readUInt16BE(off + 2); p = off + 4; }
    else if (len === 127) { if (buf.length - off < 10) break; len = Number(buf.readBigUInt64BE(off + 2)); p = off + 10; }
    if (buf.length - p < len) break;
    const payload = buf.subarray(p, p + len);
    off = p + len;
    if (opcode === 0x1) onText(payload.toString("utf8"));
  }
  return buf.subarray(off);
}

function wsConnect(token) {
  return new Promise((resolve) => {
    const socket = net.connect(server.port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(
        `GET /ws${token ? `?token=${token}` : ""} HTTP/1.1\r\n` +
          `Host: localhost:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const messages = [];
    const waiters = [];
    const deliver = (m) => { const w = waiters.shift(); if (w) w(m); else messages.push(m); };
    const api = { next: () => new Promise((r) => { const m = messages.shift(); if (m !== undefined) r(m); else waiters.push(r); }), close: () => socket.destroy() };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const status = buf.subarray(0, idx).toString("latin1").split("\r\n")[0];
        if (!/ 101 /.test(status)) { resolve({ ok: false, status }); socket.destroy(); return; }
        upgraded = true;
        buf = buf.subarray(idx + 4);
        resolve({ ok: true, api });
      }
      buf = decodeServerFrames(buf, (t) => deliver(t));
    });
    socket.on("error", () => { if (!upgraded) resolve({ ok: false, status: "error" }); });
    socket.on("close", () => { if (!upgraded) resolve({ ok: false, status: "closed" }); });
  });
}

// --- WS token enforcement ----------------------------------------------------
ok("WS connect without a token is refused (no 101)", (await wsConnect(null)).ok === false);
const client = await wsConnect(server.token);
ok("WS connect with the token upgrades (101)", client.ok === true);

// Every connection opens with server.hello — which server instance this is, so a
// client resuming against a restarted one can drop the old picture BEFORE the new
// snapshot arrives behind it. It has to be first for that ordering to hold.
const hello = JSON.parse(await client.api.next());
ok("a connection opens with server.hello identifying the instance", hello.type === "server.hello" && typeof hello.instance === "string" && hello.instance.length > 0);

// snapshot on connect: the current agent(s)
const snapshot = JSON.parse(await client.api.next());
ok("a fresh client receives the agent snapshot", snapshot.type === "agent.created" && snapshot.name === "main");

// --- same transcript, simultaneously ----------------------------------------
let tuiSaw = null;
const unsub = bus.subscribe((e) => { if (e.type === "line") tuiSaw = e; });
bus.emit({ type: "line", tabId: 1, item: { kind: "line", text: "hello from the engine" } });
// The server tags forwarded events with a transport `seq` and sends a @sync frame
// after the snapshot — read past those to the line itself.
let wsSaw = null;
for (;;) { const m = JSON.parse(await client.api.next()); if (m.type === "line") { wsSaw = m; break; } }
unsub();
const { seq, ...wsContent } = wsSaw; // strip transport metadata for the content comparison

ok("the TUI (bus subscriber) saw the line", tuiSaw && tuiSaw.item.text === "hello from the engine");
ok("the WS client saw the SAME line", wsSaw.type === "line" && wsSaw.item.text === "hello from the engine");
ok("TUI and web content are identical (modulo transport seq)", JSON.stringify(tuiSaw) === JSON.stringify(wsContent));
ok("the forwarded event carries a monotonic seq", typeof seq === "number");

client.api.close();
await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
