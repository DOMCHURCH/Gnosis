// Verify (1.4 — searchable prompt history): gatherPromptHistory returns prior
// user prompts newest-first (this session, then prior sessions for the SAME cwd),
// de-duplicated, excluding inter-agent relays and the current session; and Ctrl+R
// opens the reverse-search picker over them in the TUI.
process.env.USERPROFILE = "C:/Users/Dominique/dom/verify/_fakehome-hist";
process.env.HOME = process.env.USERPROFILE;

// Ink batches its output under CI and never writes the intermediate frames these
// assertions read. Must be imported before ink — see verify/_inkenv.mjs.
import "./_inkenv.mjs";
import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { gatherPromptHistory } from "../dist/history.js";
import { App } from "../dist/ui/App.js";
import { Engine } from "../dist/engine.js";
import { createSession } from "../dist/config.js";
import { detectCaps } from "../dist/ui/terminal.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");

// --- unit: gatherPromptHistory ----------------------------------------------
{
  const currentMessages = [
    { role: "user", text: "first prompt" },
    { role: "assistant", text: "..." },
    { role: "user", text: "[message from worker]\nrelay text" },
    { role: "user", text: "second prompt" },
  ];
  const sessions = [
    { id: "s-cur", cwd: "/a", messages: [] }, // current session — excluded by id
    { id: "s1", cwd: "/a", messages: [{ role: "user", text: "prior one" }, { role: "user", text: "second prompt" }] },
    { id: "s2", cwd: "/b", messages: [{ role: "user", text: "other cwd prompt" }] }, // wrong cwd
  ];
  const h = gatherPromptHistory({ currentMessages, currentSessionId: "s-cur", sessions, cwd: "/a" });
  ok("current-session prompts come first, newest first", h[0] === "second prompt" && h[1] === "first prompt");
  ok("prior same-cwd session prompts follow", h.includes("prior one"));
  ok("duplicates are removed", h.filter((p) => p === "second prompt").length === 1);
  ok("inter-agent relays are excluded", !h.some((p) => p.includes("[message from")));
  ok("other-cwd sessions are excluded", !h.includes("other cwd prompt"));
  ok("the current session (by id) isn't double-counted", h.length === 3);
}

// --- UI: Ctrl+R opens the reverse-search picker -----------------------------
try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}
globalThis.fetch = async () => new Response("{}", { status: 200 });

const frames = [];
const stdout = new EventEmitter();
stdout.columns = 100; stdout.rows = 40; stdout.isTTY = true;
stdout.write = (s) => { frames.push(s); return true; };
const stdin = new EventEmitter();
stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
stdin.resume = () => {}; stdin.pause = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
const inq = [];
stdin.read = () => (inq.length ? inq.shift() : null);
const send = (s) => { inq.push(s); stdin.emit("readable"); };
const allText = () => strip(frames.join("\n"));

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const cwd = "C:/Users/Dominique/dom";
const engine = new Engine({ apiKey: "test", cwd, systemPrompt: "t", models: [model], session: createSession(cwd, "m", "ask"), skills: [], autoCommit: false });
engine.messages.push({ role: "user", text: "refactor the auth module" }); // a prior prompt to find

const app = render(
  React.createElement(App, { engine, caps: detectCaps(), width: 100, ghAuth: "-", initialRepo: { branch: null, dirtyCount: 0 }, skillWarnings: [], defaultModel: "m" }),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
);
await wait(120);
send("\x12"); // Ctrl+R
await wait(200);
{
  const txt = allText();
  ok("Ctrl+R opens the reverse-search prompt-history picker", txt.includes("reverse-search prompt history"));
  ok("...showing the prior prompt", txt.includes("refactor the auth module"));
}
try { app.unmount(); } catch {}
try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
