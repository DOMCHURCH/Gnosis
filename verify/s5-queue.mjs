// Verify (feature 1 — queued input): typing while a turn runs queues the message
// instead of dropping it; it's sent as the next user message at the turn
// boundary; Esc discards the queue; Ctrl+C aborts the turn but KEEPS the queue.
// Drives the real App through mock stdin/stdout, gating fetch so a turn stays
// "busy" for a controllable window. Isolated to a fake home; fully offline.
process.env.USERPROFILE = "C:/Users/Dominique/dom/verify/_fakehome-queue";
process.env.HOME = process.env.USERPROFILE;

import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { App } from "../dist/ui/App.js";
import { Engine } from "../dist/engine.js";
import { createSession } from "../dist/config.js";
import { detectCaps } from "../dist/ui/terminal.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");

// A chat completion whose fetch hangs on `releaseTurn` (or rejects on abort), so
// the turn stays busy until the test releases it. /models is answered instantly.
let releaseTurn = () => {};
const sse = (body) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const done = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":0}}\n\ndata: [DONE]\n\n`;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("/models")) {
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  await new Promise((resolve, reject) => {
    const s = opts?.signal;
    if (s?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    releaseTurn = resolve;
    s?.addEventListener?.("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  return sse(done);
};

const frames = [];
const stdout = new EventEmitter();
stdout.columns = 100; stdout.rows = 40; stdout.isTTY = true;
stdout.write = (s) => { frames.push(s); return true; };
const allText = () => strip(frames.join("\n"));

const stdin = new EventEmitter();
stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
stdin.resume = () => {}; stdin.pause = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
const inq = [];
stdin.read = () => (inq.length ? inq.shift() : null);
const send = (s) => { inq.push(s); stdin.emit("readable"); };
const ENTER = "\r";
const ESC = "\x1b";
const CTRLC = "\x03";
const type = async (s) => { for (const ch of s) { send(ch); await wait(12); } await wait(50); };
const keyp = async (s) => { send(s); await wait(120); };

const models = [{ id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] }];
try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}

const session = createSession("C:/Users/Dominique/dom", "m", "yolo"); // yolo: no permission prompts
const engine = new Engine({ apiKey: "test", cwd: "C:/Users/Dominique/dom", systemPrompt: "test", models, session, skills: [], autoCommit: false });

let app, mountError = null;
try {
  app = render(
    React.createElement(App, { engine, caps: detectCaps(), width: 100, ghAuth: "-", initialRepo: { branch: null, dirtyCount: 0 }, skillWarnings: [], defaultModel: "m" }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
} catch (e) { mountError = e; }

await wait(150);
ok("App mounts without throwing", !mountError && frames.length > 0);

// --- 1) queue while busy, flush at the turn boundary -------------------------
await type("first message");
await keyp(ENTER);
await wait(150);
ok("a turn is running (busy) after submitting", engine.busy());
ok("the first message is in history", engine.messages.some((m) => m.role === "user" && m.text === "first message"));

await type("queued follow-up");
await keyp(ENTER);
await wait(150);
ok("typing while busy does NOT drop the message — it's shown queued", allText().includes("queued follow-up"));
ok("the queued message is NOT sent yet (still busy, not in history)", !engine.messages.some((m) => m.role === "user" && m.text === "queued follow-up"));
ok("the turn is still running (queuing didn't start a new turn)", engine.busy());

releaseTurn(); // let the first turn finish → boundary → auto-send the queue
await wait(300);
ok("at the turn boundary the queued message becomes the next user message", engine.messages.some((m) => m.role === "user" && m.text === "queued follow-up"));
ok("sending the queue started a new turn", engine.busy());
releaseTurn(); // finish that turn
await wait(250);

// --- 2) Esc discards the queue (the message is never sent) -------------------
await type("second message");
await keyp(ENTER);
await wait(150);
ok("second turn is running", engine.busy());
await type("should be discarded");
await keyp(ENTER);
await wait(100);
await keyp(ESC); // clears the queue
await wait(100);
releaseTurn(); // finish the turn — nothing should auto-send
await wait(300);
ok("Esc-cleared message is never sent", !engine.messages.some((m) => m.role === "user" && m.text === "should be discarded"));
await wait(50);

// --- 3) Ctrl+C aborts the turn but KEEPS the queue --------------------------
await type("third message");
await keyp(ENTER);
await wait(150);
ok("third turn is running", engine.busy());
await type("kept across abort");
await keyp(ENTER);
await wait(100);
await keyp(CTRLC); // aborts the turn; the queue must survive (not fire, not clear)
await wait(300);
ok("Ctrl+C ends the turn", !engine.busy());
ok("Ctrl+C did NOT auto-send the queued message", !engine.messages.some((m) => m.role === "user" && m.text === "kept across abort"));
// The kept queue is sent on demand with an empty Enter.
await keyp(ENTER);
await wait(200);
ok("the kept queue is still there and flushes on an empty enter", engine.messages.some((m) => m.role === "user" && m.text === "kept across abort"));
releaseTurn();
await wait(150);

try { app?.unmount(); } catch {}
try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
