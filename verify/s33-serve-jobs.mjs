// Verify (Background jobs API over the real server): the token-gated routes
// /api/jobs and /api/job expose the SAME job manager the TUI's /jobs drives — a
// launched background job shows up in the list with pid/command, its captured
// output is fetchable, kill terminates it, and the gates (401 bad token, 403
// non-localhost Host) hold. Exercises the actual server.ts + jobs.ts, not mocks.
import http from "node:http";
import { promises as fs } from "node:fs";
import { waitFor } from "./_wait.mjs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");
const { jobs } = await import("../dist/jobs.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(pathWithQuery, { host = "localhost" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, path: pathWithQuery, method: "GET", headers: { Host: host } }, (res) => {
      let body = ""; res.on("data", (c) => { body += c.toString("utf8"); }); res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject); req.end();
  });
}

const bus = new EventBus();
const bridge = createBridge(bus);
const server = await startServer(bridge, { port: 0 });

// job.start/job.end must reach the bus (the bridge the server installs).
const seen = [];
bus.subscribe((e) => { if (e.type === "job.start" || e.type === "job.end") seen.push(e); });

try {
  const T = server.token;
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), "dom-jproj-"));

  // A real, long-ish background job that prints immediately then lingers.
  const job = jobs.launch(`node -e "console.log('hello-from-job'); setInterval(()=>{}, 1000)"`, proj, "main", 3);

  // Wait for the job to actually appear, rather than assuming 400ms was enough
  // for node to boot and flush a line. On a loaded runner it is not, and the
  // assertions below then describe a job that simply had not started yet.
  const appeared = await waitFor(async () => {
    const r = await httpGet(`/api/jobs?token=${T}`);
    if (r.status !== 200) return null;
    return JSON.parse(r.body).jobs.find((j) => j.id === job.id) ?? null;
  });
  ok("the job starts within the deadline", !!appeared);

  const list = await httpGet(`/api/jobs?token=${T}`);
  ok("/api/jobs returns 200 with a valid token", list.status === 200);
  const listJson = JSON.parse(list.body);
  const mine = listJson.jobs.find((j) => j.id === job.id);
  ok("the launched job appears in the list", !!mine && mine.command.includes("hello-from-job"));
  ok("the job carries a pid and running status", mine.pid > 0 && mine.status === "running");
  ok("job.start reached the bus with the owner tabId", seen.some((e) => e.type === "job.start" && e.jobId === job.id && e.tabId === 3));

  // Output capture is asynchronous too — the process having started does not
  // mean its first line has been read yet.
  const out = await waitFor(async () => {
    const r = await httpGet(`/api/job?token=${T}&id=${job.id}`);
    return r.status === 200 && JSON.parse(r.body).output.includes("hello-from-job") ? r : null;
  });
  ok("/api/job returns the captured output", !!out);

  const unknown = await httpGet(`/api/job?token=${T}&id=99999`);
  ok("/api/job 404s for an unknown job", unknown.status === 404);

  // gates
  ok("bad token → 401", (await httpGet(`/api/jobs?token=WRONG`)).status === 401);
  ok("non-localhost Host → 403", (await httpGet(`/api/jobs?token=${T}`, { host: "evil.example.com" })).status === 403);

  // kill (server does this via a WS job.kill; the manager path is the same call)
  jobs.kill(job.id);
  // Killing is a signal, not a synchronous state change — the status flips when
  // the OS reports the process gone, which is not on a fixed schedule.
  const after = await waitFor(async () => {
    const r = await httpGet(`/api/jobs?token=${T}`);
    const j = JSON.parse(r.body).jobs.find((x) => x.id === job.id);
    return j && j.status === "killed" ? j : null;
  });
  ok("kill moves the job out of running", !!after);
  ok("job.end reached the bus", seen.some((e) => e.type === "job.end" && e.jobId === job.id));

  await fs.rm(proj, { recursive: true, force: true }).catch(() => {});
} catch (e) {
  ok(`serve-jobs completed (${e.message})`, false);
}

jobs.killAll();
await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
