// Verify (feature 2 — todo tool): the model-maintained task list. A todo call
// replaces the whole list and updates engine.todos; the list persists per session
// and restores on load; /clear empties it; and the App renders it above the input
// with ○ pending / ◐ active / ● done glyphs. Isolated to a fake home, offline.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");
process.env.USERPROFILE = path.join(here, "_fakehome-todo");
process.env.HOME = process.env.USERPROFILE;

// Ink batches its output under CI and never writes the intermediate frames these
// assertions read. Must be imported before ink — see verify/_inkenv.mjs.
import "./_inkenv.mjs";
import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { App } from "../dist/ui/App.js";
import { Engine } from "../dist/engine.js";
import { createSession, loadSession } from "../dist/config.js";
import { detectCaps } from "../dist/ui/terminal.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");

const sse = (body) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const done = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
const toolSSE = (name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n` +
  `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
let pending = null, served = false;
globalThis.fetch = async (url) => {
  if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  if (pending && !served) { served = true; return sse(toolSSE(pending.name, pending.args)); }
  return sse(done);
};

try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] };
const cwd = REPO_ROOT;
const engine = new Engine({ apiKey: "test", cwd, systemPrompt: "t", models: [model], session: createSession(cwd, "m", "yolo"), skills: [], autoCommit: false });

async function turn(name, args) {
  pending = { name, args }; served = false;
  const results = [];
  await engine.run("go", { onLine() {}, onPending() {}, onAssistant() {}, onToolStart() {}, onToolResult(_c, r) { results.push(r); }, onSystem() {}, async requestPermission() { return "yes"; } });
  return results[0];
}

// --- 1) a todo call updates the list + returns a count summary --------------
{
  const r = await turn("todo", { items: [{ text: "scaffold files", status: "done" }, { text: "wire the tool", status: "active" }, { text: "write tests", status: "pending" }] });
  ok("todo result summarizes counts", !r.isError && /3 tasks — 1 done, 1 active, 1 pending/.test(r.output));
  ok("engine.todos reflects the call (order + statuses)", engine.todos.length === 3 && engine.todos[1].text === "wire the tool" && engine.todos[1].status === "active");
}

// --- 2) persistence: saved to the session, restored on load -----------------
await engine.persist();
{
  const s = await loadSession(engine.sessionId());
  ok("todos persist into the session file", !!s && Array.isArray(s.todos) && s.todos.length === 3 && s.todos[0].text === "scaffold files");
}

// --- 3) a second call REPLACES the whole list (not a merge) -----------------
{
  await turn("todo", { items: [{ text: "only task left", status: "active" }] });
  ok("a second todo call replaces the list", engine.todos.length === 1 && engine.todos[0].text === "only task left");
}

// --- 4) /clear (engine.clear) empties the list ------------------------------
{
  engine.clear();
  ok("engine.clear() empties the task list", engine.todos.length === 0);
}

// --- 5) the App renders the list above the input with status glyphs ---------
{
  const caps = { ...detectCaps(), legacy: false }; // force the unicode ○/◐/● markers
  const uiEngine = new Engine({ apiKey: "test", cwd, systemPrompt: "t", models: [model], session: createSession(cwd, "m", "yolo"), skills: [], autoCommit: false });
  uiEngine.todos = [{ text: "scaffold files", status: "done" }, { text: "wire the tool", status: "active" }, { text: "write tests", status: "pending" }];

  const frames = [];
  const stdout = new EventEmitter();
  stdout.columns = 100; stdout.rows = 40; stdout.isTTY = true;
  stdout.write = (s) => { frames.push(s); return true; };
  const stdin = new EventEmitter();
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
  stdin.resume = () => {}; stdin.pause = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  stdin.read = () => null;

  const app = render(
    React.createElement(App, { engine: uiEngine, caps, width: 100, ghAuth: "-", initialRepo: { branch: null, dirtyCount: 0 }, skillWarnings: [], defaultModel: "m" }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
  await wait(150);
  const txt = strip(frames.join("\n"));
  ok("the todo panel shows each task's text", txt.includes("scaffold files") && txt.includes("wire the tool") && txt.includes("write tests"));
  ok("the todo panel uses ○ pending / ◐ active / ● done glyphs", txt.includes("○") && txt.includes("◐") && txt.includes("●"));
  try { app.unmount(); } catch {}
}

try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
