// Verify (dom serve — the COMMAND, run for real): spawn the actual `node dist/cli.js
// serve` binary the way a user types it and confirm a tokenized 127.0.0.1 URL is the
// first stdout output, that a browser can connect to it, and that a busy port exits
// with a clear error. This closes the gap where s14 tested the server MODULE while
// the command itself was unreachable (the same gap that once hid /init).
import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../dist/cli.js");
const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
const env = { ...process.env, OPENROUTER_API_KEY: "test-key", USERPROFILE: fake, HOME: fake, NO_COLOR: "1", DOM_NO_BUILD: "1" };

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

function spawnServe(args) {
  const child = spawn(process.execPath, [cli, "serve", ...args], { env });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  return { child, getOut: () => out, getErr: () => err };
}
async function waitForUrl(getOut, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const m = getOut().match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/);
    if (m) return { url: m[0], port: Number(m[1]), token: m[2] };
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// minimal browser-like WS client (decodes unmasked server text frames)
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
function wsConnect(port, token) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      socket.write(`GET /ws?token=${token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), up = false;
    const backlog = [], waiters = [];
    const deliver = (o) => { const w = waiters.shift(); if (w) w(o); else backlog.push(o); };
    const api = { next: () => new Promise((r) => { const m = backlog.shift(); m !== undefined ? r(m) : waiters.push(r); }), close: () => socket.destroy() };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!up) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; if (!/ 101 /.test(buf.subarray(0, i).toString())) { resolve({ ok: false }); socket.destroy(); return; } up = true; buf = buf.subarray(i + 4); resolve({ ok: true, api }); }
      buf = decodeServer(buf, (t) => { try { deliver(JSON.parse(t)); } catch {} });
    });
    socket.on("error", () => { if (!up) resolve({ ok: false }); });
  });
}

// --- run the real command ----------------------------------------------------
const s = spawnServe(["--port", "0"]);
const info = await waitForUrl(s.getOut);
ok("real `dom serve` prints a tokenized 127.0.0.1 URL", !!info && /token=/.test(info.url));
ok("the URL is the first stdout output", s.getOut().trimStart().startsWith("dom serve"));

if (info) {
  const client = await wsConnect(info.port, info.token);
  ok("a browser can connect to the served URL with its token", client.ok === true);
  if (client.ok) {
    const snap = await client.api.next();
    ok("the connected browser receives an agent snapshot", snap.type === "agent.created");
    client.api.close();
  } else {
    ok("the connected browser receives an agent snapshot", false);
  }
}
s.child.kill();

// --- port already in use → clear error, non-zero exit ------------------------
const blocker = net.createServer();
await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
const busyPort = blocker.address().port;
const s2 = spawnServe(["--port", String(busyPort)]);
const code = await new Promise((res) => s2.child.on("exit", res));
ok("serving on a busy port exits non-zero", code === 1);
ok("...with a clear 'already in use' message naming the port", new RegExp(`port ${busyPort} is already in use`).test(s2.getErr()));
blocker.close();

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
