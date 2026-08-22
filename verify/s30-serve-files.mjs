// Verify (File Browser API over the real server): the token-gated HTTP routes
// /api/tree and /api/file serve the active session's cwd, refuse a bad/absent
// token (401), refuse a non-localhost Host (403), and refuse ../ traversal (404).
// This exercises the ACTUAL server.ts request path, not just the filetree module.
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake; process.env.HOME = fake;

const { EventBus, createBridge } = await import("../dist/events.js");
const { startServer } = await import("../dist/server.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// A real project dir to browse.
const proj = await fs.mkdtemp(path.join(os.tmpdir(), "dom-proj-"));
await fs.writeFile(path.join(proj, "readme.md"), "# hi\n");
await fs.mkdir(path.join(proj, "src"), { recursive: true });
await fs.writeFile(path.join(proj, "src", "main.ts"), "export const n = 41;\n");
await fs.mkdir(path.join(proj, "node_modules"), { recursive: true });
await fs.writeFile(path.join(proj, "node_modules", "junk.js"), "noise");

const bus = new EventBus();
const bridge = createBridge(bus);
bridge.getAgents = () => [{ id: 7, name: "main", cwd: proj, model: "m", mode: "ask", busy: false }];
const server = await startServer(bridge, { port: 0 });

// HTTP GET with an explicit Host header (to exercise the localhost allowlist).
// http.request decodes chunked transfer encoding for us.
function httpGet(pathWithQuery, { host = "localhost" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, path: pathWithQuery, method: "GET", headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

try {
  const T = server.token;

  // tree with a valid token
  const tree = await httpGet(`/api/tree?token=${T}&tabId=7`);
  ok("/api/tree returns 200 with a valid token", tree.status === 200);
  const treeJson = JSON.parse(tree.body);
  ok("tree contains the project files", treeJson.tree.some((n) => n.name === "readme.md") && treeJson.tree.some((n) => n.name === "src"));
  ok("tree excludes node_modules over the wire", !treeJson.tree.some((n) => n.name === "node_modules"));

  // file with a valid token
  const file = await httpGet(`/api/file?token=${T}&tabId=7&path=src/main.ts`);
  ok("/api/file returns 200 for a real file", file.status === 200);
  ok("file body carries the content", JSON.parse(file.body).content.includes("const n = 41"));

  // traversal guard over the wire → 404
  const esc = await httpGet(`/api/file?token=${T}&tabId=7&path=${encodeURIComponent("../../../../etc/passwd")}`);
  ok("/api/file refuses ../ traversal (404)", esc.status === 404);

  // unknown tab → 404
  const unk = await httpGet(`/api/tree?token=${T}&tabId=999`);
  ok("/api/tree 404s for an unknown tab", unk.status === 404);

  // bad token → 401 (gate runs before routing)
  const badTok = await httpGet(`/api/tree?token=WRONG&tabId=7`);
  ok("a bad token is rejected (401)", badTok.status === 401);

  // no token → 401
  const noTok = await httpGet(`/api/tree?tabId=7`);
  ok("an absent token is rejected (401)", noTok.status === 401);

  // non-localhost Host → 403 (DNS-rebinding defense), even with a good token
  const badHost = await httpGet(`/api/tree?token=${T}&tabId=7`, { host: "evil.example.com" });
  ok("a non-localhost Host is rejected (403)", badHost.status === 403);
} catch (e) {
  ok(`serve-files completed (${e.message})`, false);
}

await server.close();
try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
try { await fs.rm(proj, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
