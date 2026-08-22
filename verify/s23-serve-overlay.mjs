// Verify (interactive overlay through the REAL `dom serve` binary): spawn the
// actual command a user runs, connect as a browser would, type `/model`, and
// confirm the picker opens IN THE BROWSER (an overlay.open frame arrives), that
// selecting a model resolves it and switches the model, and that cancelling closes
// cleanly. This is the round-trip the user asked to see working end-to-end — not a
// module test. The modal's own filter/arrow-key UI is browser-only (see s22 for the
// wire contract; the DOM interactions can't be driven headlessly here).
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
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  return { child, getOut: () => out };
}
async function waitForUrl(getOut, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const m = getOut().match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/);
    if (m) return { port: Number(m[1]), token: m[2] };
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function decode(buf, onText) { let o = 0; while (buf.length - o >= 2) { const op = buf[o] & 0x0f; let len = buf[o + 1] & 0x7f; let p = o + 2; if (len === 126) { if (buf.length - o < 4) break; len = buf.readUInt16BE(o + 2); p = o + 4; } else if (len === 127) { if (buf.length - o < 10) break; len = Number(buf.readBigUInt64BE(o + 2)); p = o + 10; } if (buf.length - p < len) break; if (op === 0x1) onText(buf.subarray(p, p + len).toString("utf8")); o = p + len; } return buf.subarray(o); }
function enc(str) { const pl = Buffer.from(str); const len = pl.length; const mask = crypto.randomBytes(4); let h; if (len < 126) h = Buffer.from([0x81, 0x80 | len]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(len, 2); } const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = pl[i] ^ mask[i % 4]; return Buffer.concat([h, mask, out]); }

function connect(port, token) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => { const k = crypto.randomBytes(16).toString("base64"); s.write(`GET /ws?token=${token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`); });
    let buf = Buffer.alloc(0), up = false; const bl = [], w = [];
    const deliver = (o) => { const i = w.findIndex((x) => x.p(o)); if (i >= 0) { const [x] = w.splice(i, 1); x.d(o); } else bl.push(o); };
    const api = { send: (o) => s.write(enc(JSON.stringify(o))), waitFor: (p, ms = 2000) => new Promise((res, rej) => { const i = bl.findIndex(p); if (i >= 0) return res(bl.splice(i, 1)[0]); const t = setTimeout(() => rej(new Error("timeout")), ms); w.push({ p, d: (o) => { clearTimeout(t); res(o); } }); }), close: () => s.destroy() };
    s.on("data", (c) => { buf = Buffer.concat([buf, c]); if (!up) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; up = true; buf = buf.subarray(i + 4); resolve(api); } buf = decode(buf, (t) => { try { deliver(JSON.parse(t)); } catch {} }); });
  });
}

const s = spawnServe(["--port", "0"]);
const info = await waitForUrl(s.getOut);
ok("real `dom serve` prints a tokenized URL to drive", !!info);

if (info) {
  try {
    const c = await connect(info.port, info.token);
    const snap = await c.waitFor((e) => e.type === "agent.created", 5000);
    const tabId = snap.tabId;

    // 1) `/model` from the browser opens the picker IN THE BROWSER (fetchModels may
    // reach the public catalog or fall back — either way a list arrives).
    c.send({ type: "command", tabId, command: "/model" });
    const open = await c.waitFor((e) => e.type === "overlay.open" && e.kind === "model", 16000);
    ok("/model opens a picker in the browser (overlay.open)", !!open && Array.isArray(open.items) && open.items.length > 0);
    ok("the picker carries the current model as the selection", typeof open.selected === "string" && open.selected.length > 0);

    // 2) selecting a (different) model resolves the overlay and actually switches.
    const target = (open.items.find((it) => it.value !== open.selected) ?? open.items[0]).value;
    c.send({ type: "overlay.select", id: open.id, value: target });
    const resolved = await c.waitFor((e) => e.type === "overlay.resolved" && e.id === open.id, 5000);
    ok("selecting resolves the overlay (closes both clients)", !!resolved);
    const line = await c.waitFor((e) => e.type === "line" && e.item?.kind === "system" && String(e.item.text).includes(target), 5000);
    ok("the selected model is applied on the live engine", !!line);

    // 3) Esc/cancel path: reopen, cancel, and confirm a clean resolve (no orphan).
    c.send({ type: "command", tabId, command: "/model" });
    const open2 = await c.waitFor((e) => e.type === "overlay.open" && e.kind === "model", 16000);
    c.send({ type: "overlay.cancel", id: open2.id });
    const res2 = await c.waitFor((e) => e.type === "overlay.resolved" && e.id === open2.id, 5000);
    ok("cancelling resolves cleanly with no orphaned pending", !!res2 && open2.id !== open.id);

    c.close();
  } catch (e) {
    ok(`overlay round-trip through the real binary (${e.message})`, false);
  }
}
s.child.kill();

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
