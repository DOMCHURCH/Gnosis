// Verify (webhook inspector + serveinfo over the real server): POST /webhook/:label
// captures a payload, emits webhook.received, and shows up in /api/webhooks; replay
// re-sends it to a local target; /api/serveinfo reports the public URL; the token +
// Host gates hold. Exercises the actual server.ts + webhooks.ts.
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");
const { webhooks } = await import("../dist/webhooks.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

function req(method, pathWithQuery, { host = "localhost", body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: server.port, path: pathWithQuery, method, headers: { Host: host, "content-type": "application/json" } }, (res) => {
      let b = ""; res.on("data", (c) => { b += c.toString("utf8"); }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", reject); if (body != null) r.write(body); r.end();
  });
}

webhooks.clear();
const bus = new EventBus();
const bridge = createBridge(bus);
const server = await startServer(bridge, { port: 0 });
const events = [];
bus.subscribe((e) => { if (e.type === "webhook.received") events.push(e); });

// A local target that records the replayed request.
let replayed = null;
const target = http.createServer((rq, rs) => { let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => { replayed = { method: rq.method, body: b }; rs.writeHead(200); rs.end("ok"); }); });
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const targetUrl = `http://127.0.0.1:${target.address().port}/hook`;

try {
  const T = server.token;

  // capture
  const payload = JSON.stringify({ event: "checkout.session.completed", amount: 4200 });
  const cap = await req("POST", `/webhook/stripe?token=${T}`, { body: payload });
  ok("POST /webhook/:label returns 200 ok", cap.status === 200 && JSON.parse(cap.body).ok === true);
  const id = JSON.parse(cap.body).id;
  ok("webhook.received was emitted on the bus", events.some((e) => e.label === "stripe" && e.id === id));

  // list
  const list = await req("GET", `/api/webhooks?token=${T}`);
  const lj = JSON.parse(list.body);
  ok("/api/webhooks lists the captured webhook", list.status === 200 && lj.webhooks.some((w) => w.id === id && w.label === "stripe"));
  ok("the stored body is the posted payload", lj.webhooks.find((w) => w.id === id).body === payload);
  ok("/api/webhooks reports public:null when no tunnel", lj.public === null);

  // replay
  const rep = await req("POST", `/api/webhooks/${id}/replay?token=${T}`, { body: JSON.stringify({ target: targetUrl }) });
  ok("replay returns ok with the target's status", rep.status === 200 && JSON.parse(rep.body).ok === true && JSON.parse(rep.body).status === 200);
  ok("the target actually received the replayed payload", replayed && replayed.method === "POST" && replayed.body === payload);
  const badReplay = await req("POST", `/api/webhooks/nope/replay?token=${T}`, { body: "{}" });
  ok("replay 404s for an unknown id", badReplay.status === 404);

  // serveinfo reflects setPublicUrl
  ok("/api/serveinfo is null before a tunnel", JSON.parse((await req("GET", `/api/serveinfo?token=${T}`)).body).public === null);
  server.setPublicUrl("https://demo.trycloudflare.com");
  ok("/api/serveinfo reports the public URL once set", JSON.parse((await req("GET", `/api/serveinfo?token=${T}`)).body).public === "https://demo.trycloudflare.com");

  // gates
  ok("bad token → 401 on capture", (await req("POST", `/webhook/x?token=WRONG`, { body: "{}" })).status === 401);
  ok("non-localhost Host → 403 on capture", (await req("POST", `/webhook/x?token=${T}`, { host: "evil.example.com", body: "{}" })).status === 403);
} catch (e) {
  ok(`serve-webhooks completed (${e.message})`, false);
}

await server.close();
await new Promise((r) => target.close(r));
webhooks.clear();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
