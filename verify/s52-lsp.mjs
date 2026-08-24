// Verify (LSP Lite): the language chooser picks the right type checker gated on the
// project marker; the error counter parses each tool's output; and — with a REAL tsc
// run through the engine — an edit that introduces a type error is caught, surfaced
// as "type check: N errors", fed back, and the fix loop clears it.
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const L = await import(pathToFileURL(path.resolve(repoRoot, "dist/lsp.js")).href);

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

// --- editedLangs -----------------------------------------------------------------
ok("edited langs are detected by extension", (() => {
  const s = L.editedLangs(["a.ts", "b.tsx", "c.py", "d.rs", "e.md"]);
  return s.has("ts") && s.has("python") && s.has("rust") && s.size === 3;
})());

// --- chooseLsp: gated on marker, priority ts → rust → python ---------------------
const M = (o) => ({ tsconfig: false, cargo: false, python: false, ...o });
ok("TS edit + tsconfig → tsc --noEmit", L.chooseLsp(["src/a.ts"], M({ tsconfig: true }))?.command === "npx --no-install tsc --noEmit");
ok("TS edit without tsconfig → no check", L.chooseLsp(["src/a.ts"], M({})) === null);
ok("Rust edit + Cargo.toml → cargo check", L.chooseLsp(["src/a.rs"], M({ cargo: true }))?.command === "cargo check --quiet");
ok("Python edit + marker → mypy on the edited files", (() => {
  const c = L.chooseLsp(["pkg/a.py", "pkg/b.py"], M({ python: true }));
  return c?.lang === "python" && /^mypy --ignore-missing-imports /.test(c.command) && c.command.includes("pkg/a.py") && c.command.includes("pkg/b.py");
})());
ok("Python edit without a python marker → no check", L.chooseLsp(["a.py"], M({})) === null);
ok("TS wins when several languages are edited", L.chooseLsp(["a.ts", "b.rs", "c.py"], M({ tsconfig: true, cargo: true, python: true }))?.lang === "ts");
ok("a non-code edit → no check", L.chooseLsp(["README.md"], M({ tsconfig: true })) === null);

// --- countLspErrors: prefer the summary, else per-error markers ------------------
ok("tsc: reads the 'Found N errors' summary", L.countLspErrors("ts", "src/x.ts(3,7): error TS2322: ...\nFound 2 errors in 1 file.") === 2);
ok("tsc: falls back to counting error TS lines", L.countLspErrors("ts", "a.ts(1,1): error TS1005\nb.ts(2,2): error TS2322") === 2);
ok("tsc: clean output is 0", L.countLspErrors("ts", "") === 0);
ok("mypy: reads its 'Found N errors' summary", L.countLspErrors("python", "m.py:2: error: Incompatible types\nFound 1 error in 1 file") === 1);
ok("rust: reads 'aborting due to N previous errors'", L.countLspErrors("rust", "error[E0308]: mismatched types\nerror: aborting due to 3 previous errors") === 3);
ok("rust: falls back to counting error[...] lines", L.countLspErrors("rust", "error[E0425]: x\nerror: y\nwarning: z") === 2);

// --- REAL tsc through the engine fix loop ----------------------------------------
// A temp project INSIDE the repo (so `npx --no-install tsc` resolves the repo's
// TypeScript). Root tsconfig only includes src/, so this never affects the repo.
if (!existsSync(path.join(repoRoot, "node_modules", "typescript"))) {
  console.log("SKIP real-tsc engine loop (typescript not installed)");
} else {
  const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
  process.env.USERPROFILE = fake;
  process.env.HOME = fake;
  const dir = path.join(repoRoot, `.lspv-${process.pid}-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ["bad.ts"] }));
    const { Engine } = await import(pathToFileURL(path.resolve(repoRoot, "dist/engine.js")).href);
    const { createSession } = await import(pathToFileURL(path.resolve(repoRoot, "dist/config.js")).href);
    const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
    const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
    const u = `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
    const textSSE = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n${u}`;
    const toolSSE = (name, args) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n${u}`;
    const BAD = 'export const n: number = "not a number";\n';
    const GOOD = "export const n: number = 1;\n";
    let step = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const n = step++;
      if (n === 0) return sse(toolSSE("write", { path: "bad.ts", content: BAD }));   // introduce a type error
      if (n === 1) return sse(textSSE("added it"));                                   // → LSP fails → feedback
      if (n === 2) return sse(toolSSE("write", { path: "bad.ts", content: GOOD }));   // fix it
      return sse(textSSE("fixed"));                                                   // → LSP clean
    };
    const engine = new Engine({ apiKey: "test", cwd: dir, systemPrompt: "t", models: [model], session: createSession(dir, "m", "yolo"), skills: [], autoCommit: false });
    const sys = [];
    await engine.run("build it", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult() {}, onSystem(t) { sys.push(t); }, async requestPermission() { return "yes"; } });

    ok("a real tsc run reported the type error (type check: N>0 errors)", sys.some((t) => /type check: [1-9]\d* error/.test(t)));
    ok("the type errors were fed back for a fix", engine.messages.some((m) => m.role === "user" && /Automated checks failed/.test(m.text) && /type check \(tsc\)/.test(m.text)));
    ok("the model got a fix attempt", sys.some((t) => /fix attempt 1\/3/.test(t)));
    ok("after the fix, tsc is clean (type check: 0 errors) and checks pass", sys.some((t) => /type check: 0 errors/.test(t)) && sys.some((t) => /checks pass/.test(t)));
    ok("the fixed file is on disk", (await fs.readFile(path.join(dir, "bad.ts"), "utf8")) === GOOD);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(fake, { recursive: true, force: true });
  }
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
