// Verify (dom serve from OUTSIDE the repo — the real binary): run `dom serve` with
// the working directory set to a NON-repo folder, in both a current-build and a
// stale-build state, and confirm it serves the real bundle, reports a URL, and the
// served engine's cwd is that outside folder (not the repo / INSTALL_ROOT). The
// self-build builds in INSTALL_ROOT while tools follow process.cwd(); s24 covered
// the build trigger from inside the repo but NOT this from-anywhere path.
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cli = path.join(root, "dist", "cli.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  else { try { process.kill(pid); } catch {} }
}

async function serveFromOutside({ stale }) {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "proj-"));
  await fs.writeFile(path.join(outside, "package.json"), JSON.stringify({ name: "someproj" }));
  await fs.writeFile(path.join(outside, "index.js"), "console.log(1)\n");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
  const env = { ...process.env, OPENROUTER_API_KEY: "test-key", USERPROFILE: home, HOME: home, NO_COLOR: "1" };
  if (!stale) env.DOM_NO_BUILD = "1";

  const marker = path.join(root, "src", "cli.tsx");
  const orig = fss.statSync(marker);
  if (stale) fss.utimesSync(marker, new Date(Date.now() + 120000), new Date(Date.now() + 120000));

  const child = spawn(process.execPath, [cli, "serve", "--port", "0"], { cwd: outside, env });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));

  const info = await (async () => {
    const t = Date.now();
    while (Date.now() - t < 40000) { const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/); if (m) return { port: +m[1], token: m[2] }; if (child.exitCode != null) return null; await new Promise((r) => setTimeout(r, 150)); }
    return null;
  })();

  const result = { info, err, outsideBase: path.basename(outside), body: "", agentCwdBase: "" };
  if (info) {
    result.body = await new Promise((res) => http.get({ host: "127.0.0.1", port: info.port, path: `/?token=${info.token}`, headers: { host: "localhost" } }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(b)); }).on("error", () => res("")));
    result.agentCwdBase = await readAgentCwdBase(info);
  }

  killTree(child.pid);
  if (stale) fss.utimesSync(marker, orig.atime, orig.mtime);
  await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  return result;
}

function readAgentCwdBase(info) {
  return new Promise((resolve) => {
    const s = net.connect(info.port, "127.0.0.1", () => { const k = crypto.randomBytes(16).toString("base64"); s.write(`GET /ws?token=${info.token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${k}\r\nSec-WebSocket-Version: 13\r\n\r\n`); });
    let buf = Buffer.alloc(0), up = false, base = "";
    s.on("data", (c) => { buf = Buffer.concat([buf, c]); if (!up) { const i = buf.indexOf("\r\n\r\n"); if (i === -1) return; up = true; buf = buf.subarray(i + 4); } let o = 0; while (buf.length - o >= 2) { const op = buf[o] & 0x0f; let len = buf[o + 1] & 0x7f; let p = o + 2; if (len === 126) { if (buf.length - o < 4) break; len = buf.readUInt16BE(o + 2); p = o + 4; } if (buf.length - p < len) break; if (op === 0x1) { try { const m = JSON.parse(buf.subarray(p, p + len).toString()); if (m.type === "agent.created" && !base) base = path.basename(m.cwd); } catch {} } o = p + len; } buf = buf.subarray(o); });
    setTimeout(() => { s.destroy(); resolve(base); }, 1000);
  });
}

// --- current build, from an outside dir --------------------------------------
const fresh = await serveFromOutside({ stale: false });
ok("current build: serve from a non-repo dir prints a URL", !!fresh.info);
ok("current build: serves the real bundle (not the placeholder)", fresh.body.includes("TERMINAL SESSIONS"));
ok("current build: the served engine's cwd is the outside dir, not the repo", fresh.agentCwdBase === fresh.outsideBase);

// --- stale build, from an outside dir (self-build must target INSTALL_ROOT) ---
const stale = await serveFromOutside({ stale: true });
ok("stale build: still serves a URL from a non-repo dir", !!stale.info);
ok("stale build: attempted a rebuild", /rebuilding/.test(stale.err));
// The decisive check: the build SUCCEEDED. If it had run in process.cwd() (the
// outside dir, whose package.json has no "build" script) npm would error and we'd
// see "rebuild failed" — so its absence proves the build ran in INSTALL_ROOT.
ok("stale build: rebuild succeeded (ran in INSTALL_ROOT, not process.cwd())", !/rebuild failed/.test(stale.err) && stale.body.includes("TERMINAL SESSIONS"));
ok("stale build: engine cwd is still the outside dir after the rebuild + re-exec", stale.agentCwdBase === stale.outsideBase);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
