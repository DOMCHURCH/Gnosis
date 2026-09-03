// Verify (feature 4 — pipe mode): `dom -p "prompt"` reads piped stdin, runs ONE
// turn, writes the result to stdout, and exits 0/1. No session file unless --save.
// Progress/errors go to stderr so stdout stays clean. Isolated fake home, offline.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");
process.env.USERPROFILE = path.join(here, "_fakehome-pipe");
process.env.HOME = process.env.USERPROFILE;

import { promises as fs } from "node:fs";

const { parseArgs } = await import("../dist/startup.js");
const { runPipe } = await import("../dist/pipe.js");
const { Engine } = await import("../dist/engine.js");
const { createSession, loadSession } = await import("../dist/config.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}

// --- parseArgs: -p / --print / --save --------------------------------------
{
  const f = parseArgs(["-p", "review this"]);
  ok("-p sets print and takes the prompt from the positional arg", f.print === true && f.prompt === "review this" && f.save === false);
  const g = parseArgs(["--print", "--save", "do it"]);
  ok("--print + --save recognized, prompt captured", g.print && g.save && g.prompt === "do it");
  const h = parseArgs(["-p"]);
  ok("-p with no prompt is allowed (stdin supplies it)", h.print && h.prompt === undefined);
}

// --- fetch + stdin/stdout mocks ---------------------------------------------
const sse = (b) => new Response(b, { status: 200, headers: { "content-type": "text/event-stream" } });
const answer = `data: {"choices":[{"delta":{"content":"This diff looks fine."}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
let mode = "ok";
globalThis.fetch = async (url) => {
  if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  if (mode === "err") return new Response("bad request", { status: 400 });
  return sse(answer);
};

const setStdin = (content) =>
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: { isTTY: false, async *[Symbol.asyncIterator]() { if (content) yield Buffer.from(content); } },
  });

// Intercept stdout/stderr only around a runPipe call, so ok()/console.log work.
async function capture(fn) {
  const out = [], err = [];
  const oW = process.stdout.write, eW = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  let res;
  try { res = await fn(); } finally { process.stdout.write = oW; process.stderr.write = eW; }
  return { res, out: out.join(""), err: err.join("") };
}

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const cwd = REPO_ROOT;
const mkEngine = () => new Engine({ apiKey: "test", cwd, systemPrompt: "t", models: [model], session: createSession(cwd, "m", "ask"), skills: [], autoCommit: false });

// --- 1) piped stdin + prompt → one turn, answer to stdout, exit 0 -----------
{
  mode = "ok";
  setStdin("DIFF: -foo +bar\n");
  const engine = mkEngine();
  const { res: code, out, err } = await capture(() => runPipe(engine, { prompt: "review this", save: false }));
  ok("exit code 0 on success", code === 0);
  ok("the model's answer is written to stdout", out.includes("This diff looks fine."));
  ok("progress/errors are NOT on stdout (stdout is just the answer)", out.trim() === "This diff looks fine.");
  ok("the prompt AND piped stdin both reached the model", engine.messages.some((m) => m.role === "user" && m.text.includes("review this") && m.text.includes("DIFF: -foo +bar")));
  ok("no session file is written without --save", (await loadSession(engine.sessionId())) === null);
  void err;
}

// --- 2) --save persists the one-shot turn -----------------------------------
{
  mode = "ok";
  setStdin("");
  const engine = mkEngine();
  const { res: code } = await capture(() => runPipe(engine, { prompt: "hello", save: true }));
  ok("exit 0 with --save", code === 0);
  const s = await loadSession(engine.sessionId());
  ok("--save writes the session file", !!s && s.messages.some((m) => m.role === "user" && m.text === "hello"));
}

// --- 3) nothing to do (no prompt, no stdin) → exit 1 ------------------------
{
  mode = "ok";
  setStdin("");
  const engine = mkEngine();
  const { res: code, out, err } = await capture(() => runPipe(engine, { prompt: undefined, save: false }));
  ok("no prompt and no stdin → exit 1", code === 1);
  ok("...nothing on stdout", out === "");
  ok("...a helpful message on stderr", err.includes("nothing to do"));
}

// --- 4) a provider error → exit 1, stdout stays clean -----------------------
{
  mode = "err";
  setStdin("");
  const engine = mkEngine();
  const { res: code, out, err } = await capture(() => runPipe(engine, { prompt: "x", save: false }));
  ok("a provider error yields exit 1", code === 1);
  ok("...stdout stays empty (error routed to stderr)", out === "");
  ok("...the error is on stderr", /✗|400/.test(err));
}

try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
