// Verify (serve shutdown clears the office floor): the browser draws a figure per
// `agent.created` and only removes one on `agent.closed`. Nothing used to send that
// on the way out, so stopping serve left the whole roster standing — and a reconnect
// could not fix it either (a fresh server has an empty replay ring, so it sends
// nothing that would clear them). This asserts that BOTH teardown paths — an exit
// signal and `/serve stop` — close every agent out over a real socket first.
//
// The server runs in a child process, booted from the BUILT dist/ artifacts, with a
// real HTTP+WS listener and a real browser-like client on the other end. The stop is
// delivered as a genuine SIGINT where signals exist; on Windows there are none —
// child.kill() is TerminateProcess and runs no handler at all — so the child raises
// the same 'SIGINT' event Node's own console handler raises for Ctrl+C. Either way
// it is the shipped handler, reached the way the real one is.
import { spawn } from "node:child_process";
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
const env = { ...process.env, OPENROUTER_API_KEY: "test-key", USERPROFILE: fake, HOME: fake, NO_COLOR: "1", DOM_NO_BUILD: "1" };

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- the server child: real dist/server.js, three agents on the floor ---------
const AGENTS = [1, 2, 3];
// argv: <port> <comma-separated agent ids>. A fixed port lets a second run of this
// child impersonate a RESTART of the first — same address, different process.
const harness = path.join(fake, "serve-child.mjs");
await fs.writeFile(harness, `
import { startServer } from ${JSON.stringify(pathToFileURL(path.join(root, "dist", "server.js")).href)};
import { EventBus, createBridge } from ${JSON.stringify(pathToFileURL(path.join(root, "dist", "events.js")).href)};

const port = Number(process.argv[2] ?? 0);
const ids = String(process.argv[3] ?? "1,2,3").split(",").map(Number);
const bridge = createBridge(new EventBus());
bridge.getAgents = () => ids.map((id) => ({
  id, name: "agent" + id, cwd: process.cwd(), model: "test/model", mode: "code",
  busy: false, imageInput: false, documentInput: false, contextLimit: 0,
}));
const handle = await startServer(bridge, { port });
process.stdout.write("URL " + handle.url + "\\n");

// The parent asks for one of the two teardown paths. "signal" is what a user's
// Ctrl+C does (on Windows, Node's console handler raises exactly this event);
// "stop" is what the /serve stop command does. "emit" puts one event on the bus,
// to advance the seq that a reconnecting client will quote back.
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (line) => {
  if (line.includes("signal")) process.emit("SIGINT", "SIGINT");
  if (line.includes("emit")) bridge.bus.emit({ type: "agent.busy", tabId: ids[0], busy: true });
  if (line.includes("stop")) { await handle.close(); process.stdout.write("STOPPED\\n"); }
});
setInterval(() => {}, 1 << 30);
`);

// --- minimal browser-like WS client -----------------------------------------
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
/** `resume` reconnects like the real client does: the cursor it reached, and the
 * instance that cursor was counted against. */
function wsConnect(port, token, resume) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const key = crypto.randomBytes(16).toString("base64");
      const q = resume ? `&since=${resume.since}&instance=${encodeURIComponent(resume.instance)}` : "";
      socket.write(`GET /ws?token=${token}${q} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), up = false;
    const seen = [];
    const api = {
      seen,
      /** Poll until `pred` holds, or the deadline passes. */
      until: async (pred, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (pred()) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return pred();
      },
      close: () => socket.destroy(),
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!up) {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        if (!/ 101 /.test(buf.subarray(0, i).toString())) { resolve({ ok: false }); socket.destroy(); return; }
        up = true; buf = buf.subarray(i + 4); resolve({ ok: true, api });
      }
      buf = decodeServer(buf, (t) => { try { seen.push(JSON.parse(t)); } catch { /* not json */ } });
    });
    socket.on("error", () => { if (!up) resolve({ ok: false }); });
  });
}

async function boot(port = 0, ids = AGENTS) {
  const child = spawn(process.execPath, [harness, String(port), ids.join(",")], { env, cwd: root });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  // Subscribe to 'exit' NOW, not after the teardown: it fires once, and a child
  // that dies promptly (which is the whole point here) would leave a listener
  // attached later waiting forever on an event that already happened.
  const exited = new Promise((res) => child.on("exit", res));
  let info = null;
  for (let i = 0; i < 200 && !info; i++) {
    const m = out.match(/URL http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/);
    if (m) info = { port: Number(m[1]), token: m[2] };
    else await new Promise((r) => setTimeout(r, 100));
  }
  // A child that never printed a URL failed to boot — surface why, or the suite
  // just reports "the server came up: FAIL" with no way to act on it.
  if (!info && err) console.log(err.trim().split(/\r?\n/).slice(0, 6).map((l) => `    | ${l}`).join("\n"));
  return { child, info, exited, getOut: () => out };
}

/** Connect, confirm the floor is populated, then run `teardown` and report what cleared. */
async function floorAfter(label, teardown) {
  const s = await boot();
  ok(`[${label}] the server came up`, !!s.info);
  if (!s.info) return { s };
  const client = await wsConnect(s.info.port, s.info.token);
  ok(`[${label}] a browser-like client connected`, client.ok === true);
  if (!client.ok) { s.child.kill(); return { s }; }
  const api = client.api;
  await api.until(() => api.seen.some((m) => m.type === "@sync"));
  const created = new Set(api.seen.filter((m) => m.type === "agent.created").map((m) => m.tabId));
  ok(`[${label}] the floor holds every agent to start with (${created.size} figures)`, AGENTS.every((id) => created.has(id)));

  const mark = api.seen.length;
  teardown(s.child);
  const closedSince = () => new Set(api.seen.slice(mark).filter((m) => m.type === "agent.closed").map((m) => m.tabId));
  const cleared = await api.until(() => AGENTS.every((id) => closedSince().has(id)), 10000);
  ok(`[${label}] every agent is closed out before the socket dies (got ${closedSince().size}/${AGENTS.length})`, cleared);
  // agent.closed empties the roster; floor.reset is what clears everything no
  // per-agent event covers — manual figures, sub-agents, and the chat rail.
  const reset = await api.until(() => api.seen.slice(mark).some((m) => m.type === "floor.reset"), 5000);
  ok(`[${label}] floor.reset follows, wiping what agent.closed does not`, reset);
  api.close();
  return { s };
}

// --- 1. exit signal (Ctrl+C) -------------------------------------------------
{
  const { s } = await floorAfter("exit signal", (child) => {
    if (process.platform === "win32") child.stdin.write("signal\n");
    else { try { process.kill(child.pid, "SIGINT"); } catch { /* already gone */ } }
  });
  const code = await Promise.race([s.exited, new Promise((res) => setTimeout(() => res("timeout"), 15000))]);
  ok(`[exit signal] the process exits 130 on SIGINT (got ${code})`, code === 130);
  if (code === "timeout") { try { s.child.kill(); } catch { /* already gone */ } }
}

// --- 2. /serve stop ----------------------------------------------------------
// Same broadcast, but the session keeps running afterwards — so close() must also
// be idempotent: the process exit that follows must not replay a second round.
{
  const { s } = await floorAfter("/serve stop", (child) => child.stdin.write("stop\n"));
  const stopped = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (/STOPPED/.test(s.getOut())) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return /STOPPED/.test(s.getOut());
  })();
  ok("[/serve stop] close() resolves (no hang on the socket teardown)", stopped);
  try { s.child.kill(); } catch { /* already gone */ }
}

// --- 3. restart, missed by the browser ---------------------------------------
// The case no shutdown broadcast can reach: the server dies without warning (here
// a hard kill — on Windows that is TerminateProcess, so no handler runs at all)
// and something else comes up on the same port. The client reconnects quoting a
// cursor from a server that no longer exists. It must be told this is a different
// instance, and be handed the NEW roster rather than a replay of nothing — which
// is what would leave three dead agents standing on the floor.
{
  const a = await boot(0, AGENTS);
  ok("[restart] the first server came up", !!a.info);
  if (a.info) {
    const c1 = await wsConnect(a.info.port, a.info.token);
    ok("[restart] a browser-like client connected", c1.ok === true);
    if (c1.ok) {
      await c1.api.until(() => c1.api.seen.some((m) => m.type === "@sync"));
      const hello1 = c1.api.seen.find((m) => m.type === "server.hello");
      ok("[restart] the connection opens with server.hello", !!hello1?.instance && typeof hello1.startedAt === "number");
      ok("[restart] server.hello is the FIRST frame, before any agent", c1.api.seen[0]?.type === "server.hello");

      // Advance the cursor, so the reconnect quotes a seq this server really issued.
      a.child.stdin.write("emit\n");
      await c1.api.until(() => c1.api.seen.some((m) => m.type === "agent.busy"));
      const cursor = Math.max(...c1.api.seen.filter((m) => typeof m.seq === "number").map((m) => m.seq));
      c1.api.close();

      // Kill it outright: no shutdown broadcast, nothing for the browser to hear.
      a.child.kill();
      await Promise.race([a.exited, new Promise((r) => setTimeout(r, 10000))]);

      // A different process, same port, a different roster.
      const b = await boot(a.info.port, [9]);
      ok("[restart] a replacement server came up on the same port", !!b.info);
      if (b.info) {
        const c2 = await wsConnect(b.info.port, b.info.token, { since: cursor, instance: hello1.instance });
        ok("[restart] the client reconnects to the replacement", c2.ok === true);
        if (c2.ok) {
          await c2.api.until(() => c2.api.seen.some((m) => m.type === "@sync"));
          const hello2 = c2.api.seen.find((m) => m.type === "server.hello");
          ok("[restart] server.hello reports a DIFFERENT instance", !!hello2 && hello2.instance !== hello1.instance);
          const created = new Set(c2.api.seen.filter((m) => m.type === "agent.created").map((m) => m.tabId));
          ok(`[restart] the new roster is sent outright, not replayed (got [${[...created]}])`, created.has(9));
          ok("[restart] and carries none of the dead server's agents", !AGENTS.some((id) => created.has(id)));
          c2.api.close();
        }
        b.child.kill();
      }
    } else {
      a.child.kill();
    }
  }
}

try { await fs.rm(fake, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
