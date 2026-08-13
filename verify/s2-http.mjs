// Verify 2: http gate rules (SSRF / methods) + secret substitution & redaction.
// Isolated to a fake home so the real ~/.dom/.env is never read or touched.
process.env.USERPROFILE = "C:/Users/Dominique/dom/verify/_fakehome";
process.env.HOME = process.env.USERPROFILE;

import { promises as fs } from "node:fs";
import { gate } from "../dist/permissions.js";
import { TOOLS } from "../dist/tools/index.js";
import { runHttp, envPath } from "../dist/tools/http.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) fails++; };
const http = TOOLS.http;
const g = (args, mode = "ask") => gate(http, args, { mode, approvals: new Set() });

// --- permission gate: methods ---
ok("POST prompts even in yolo (dangerous)", (() => { const d = g({ method: "POST", url: "https://api.example.com/x" }, "yolo"); return d.kind === "prompt" && d.dangerous === true; })());
ok("PUT prompts even in yolo", g({ method: "PUT", url: "https://api.example.com" }, "yolo").kind === "prompt");
ok("DELETE prompts even in yolo", g({ method: "DELETE", url: "https://api.example.com" }, "yolo").kind === "prompt");
ok("GET auto-approves in yolo", g({ method: "GET", url: "https://api.example.com" }, "yolo").kind === "allow");
ok("GET in ask mode prompts (not dangerous)", (() => { const d = g({ method: "GET", url: "https://api.example.com" }, "ask"); return d.kind === "prompt" && d.dangerous === false; })());

// --- permission gate: SSRF / scheme hard-blocks (reject, never prompt) ---
for (const host of ["http://127.0.0.1:8000", "http://localhost/x", "http://0.0.0.0", "http://10.1.2.3", "http://192.168.0.1", "http://172.16.5.5", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
  ok(`blocks ${host}`, g({ method: "GET", url: host }, "yolo").kind === "reject");
}
ok("blocks file:// scheme", g({ method: "GET", url: "file:///etc/passwd" }, "yolo").kind === "reject");
ok("blocks ftp:// scheme", g({ method: "GET", url: "ftp://host/x" }, "yolo").kind === "reject");
ok("allows a normal public 172.32.x (outside private range)", g({ method: "GET", url: "http://172.32.0.1" }, "yolo").kind === "allow");

// --- secret substitution + redaction (runHttp with a mocked fetch) ---
await fs.mkdir(envPath().replace(/[/\\][^/\\]+$/, ""), { recursive: true });
await fs.writeFile(envPath(), "WEATHER_API_KEY=secret123\n");

let captured = null;
globalThis.fetch = async (url, init) => {
  captured = { url, headers: init.headers, body: init.body };
  return new Response(JSON.stringify({ ok: true, nested: { a: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
};

const res = await runHttp({
  method: "GET",
  url: "https://api.example.com/data?key=${WEATHER_API_KEY}",
  headers: { Authorization: "Bearer ${WEATHER_API_KEY}", "X-Trace": "abc" },
});

ok("real request URL carries the substituted secret", String(captured.url).includes("secret123"));
ok("real request Authorization carries the substituted secret", captured.headers.Authorization === "Bearer secret123");
ok("transcript output NEVER contains the secret value", !res.output.includes("secret123"));
ok("transcript shows the ${VAR} placeholder verbatim in the echoed URL", res.output.includes("${WEATHER_API_KEY}"));
ok("transcript redacts the Authorization header to <redacted>", res.output.includes("Authorization: <redacted>"));
ok("JSON body is pretty-printed", res.output.includes('"nested": {'));

// --- missing key errors with the name + the file to add it to ---
const miss = await runHttp({ method: "GET", url: "https://api.example.com/?k=${MISSING_KEY_XYZ}" });
ok("missing key → error naming the variable", miss.isError && miss.output.includes("MISSING_KEY_XYZ"));
ok("missing key → error names the .env file to add it to", miss.output.includes(".env"));

// --- SSRF also enforced inside the tool itself (defense in depth) ---
const ssrf = await runHttp({ method: "GET", url: "http://127.0.0.1:9/" });
ok("runHttp itself refuses a loopback target", ssrf.isError && /127\.0\.0\.1/.test(ssrf.output));

try { await fs.rm("C:/Users/Dominique/dom/verify/_fakehome", { recursive: true, force: true }); } catch {}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
