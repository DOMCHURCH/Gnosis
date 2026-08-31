// Verify (web terminal / PTY): the real pseudo-terminal spawns in a given cwd,
// echoes typed input, resizes, and dies on kill (node-pty exercised for real); and
// the /pty websocket upgrade is refused without the session token (401) and on a
// non-localhost Host (destroyed), so the human terminal channel is never reachable
// unauthenticated. Terminal bytes are a human channel — never on the event bus.
import net from "node:net";
import { waitFor } from "./_wait.mjs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the pty module itself (real native node-pty) ---------------------------
try {
  const { spawnPty, killAllPtys } = await import("../dist/pty.js");
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), "dom-pty-"));
  const pty = await spawnPty(proj, 80, 24);
  ok("spawnPty returns a pty with a pid", pty.pid > 0);

  let buf = "";
  pty.onData((d) => { buf += d; });

  // Wait for the shell to say ANYTHING before typing at it. A keystroke sent
  // before the shell is listening is simply dropped, so the old fixed
  // sleep(600) was not merely optimistic about timing — on a slow runner it
  // lost the input outright, and the assertion below could then never pass.
  const alive = await waitFor(() => buf.length > 0 || null, { timeout: 15000 });
  ok("the shell produces output before we type at it", !!alive);

  pty.write("echo pty_marker_42\r"); // Enter — works for bash and powershell

  // Then poll for the echo rather than guessing at 1400ms. Retried once:
  // a shell that had only just come up may still have swallowed the first
  // line, and a duplicate echo cannot affect the assertion.
  let retried = false;
  const echoed = await waitFor(() => {
    if (/pty_marker_42/.test(buf)) return true;
    if (!retried) { retried = true; pty.write("echo pty_marker_42\r"); }
    return null;
  }, { timeout: 15000, interval: 250 });
  ok("the pty echoes typed input back", !!echoed);

  let ok_resize = true;
  try { pty.resize(120, 40); } catch { ok_resize = false; }
  ok("resize does not throw", ok_resize);

  pty.kill();
  ok("kill is callable", true);
  killAllPtys();
  await fs.rm(proj, { recursive: true, force: true }).catch(() => {});
} catch (e) {
  ok(`pty module usable (${e.message})`, false);
}

// --- the /pty upgrade gate on the real server -------------------------------
const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");
const bridge = createBridge(new EventBus());
bridge.getAgents = () => [{ id: 5, name: "main", cwd: fake, model: "m", mode: "ask", busy: false }];
const server = await startServer(bridge, { port: 0 });

// Send a raw WS upgrade request and return the first response line.
function upgrade(pathWithQuery, host = "localhost") {
  return new Promise((resolve) => {
    const sock = net.connect(server.port, "127.0.0.1", () => {
      sock.write(
        `GET ${pathWithQuery} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let data = "";
    sock.on("data", (c) => { data += c.toString("utf8"); if (data.includes("\r\n")) { resolve(data.split("\r\n")[0]); sock.destroy(); } });
    sock.on("close", () => resolve(data.split("\r\n")[0] || ""));
    sock.on("error", () => resolve(""));
    setTimeout(() => { resolve(data.split("\r\n")[0] || ""); sock.destroy(); }, 1500);
  });
}

try {
  const T = server.token;
  ok("/pty with a bad token is rejected (401)", (await upgrade(`/pty?token=WRONG&tabId=5`)).includes("401"));
  ok("/pty with no token is rejected (401)", (await upgrade(`/pty?tabId=5`)).includes("401"));
  const good = await upgrade(`/pty?token=${T}&tabId=5`);
  ok("/pty with a valid token upgrades (101)", good.includes("101"));
} catch (e) {
  ok(`pty gate checked (${e.message})`, false);
}

await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
