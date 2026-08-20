// Verify (1.7 — /context readout + /resume cwd picker): contextBreakdown splits
// window usage by category; /context prints it with percentages; /resume (no args)
// lists only prior sessions for the current cwd.
process.env.USERPROFILE = "C:/Users/Dominique/dom/verify/_fakehome-ctx";
process.env.HOME = process.env.USERPROFILE;

import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { contextBreakdown } from "../dist/messages.js";
import { App } from "../dist/ui/App.js";
import { Engine } from "../dist/engine.js";
import { createSession, saveSession } from "../dist/config.js";
import { detectCaps } from "../dist/ui/terminal.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");

// --- unit: contextBreakdown --------------------------------------------------
{
  const msgs = [
    { role: "user", text: "u".repeat(40) }, // 10 tok
    { role: "assistant", text: "a".repeat(20), calls: [{ id: "1", name: "read", args: '{"path":"x.ts"}' }] }, // 5 tok text
    { role: "tool", name: "read", result: "r".repeat(400), isError: false }, // ~101 tok
    { role: "user", text: "", images: [{ source: "a.png", mime: "image/png", data: "x" }] }, // 1000 tok image
  ];
  const cats = contextBreakdown(msgs, "s".repeat(80), null); // system 20 tok, no summary
  const by = Object.fromEntries(cats.map((c) => [c.name, c.tokens]));
  ok("system prompt tokens estimated", by["system prompt"] === 20);
  ok("user message tokens estimated", by["user messages"] === 10);
  ok("assistant text tokens estimated", by["assistant text"] === 5);
  ok("tool call + tool result categories present", by["tool calls"] > 0 && by["tool results"] >= 100);
  ok("images counted (~1000/image)", by["images"] === 1000);
  ok("empty categories are omitted (no summary here)", !("summary" in by));
  const cats2 = contextBreakdown(msgs, "s", "a summary here");
  ok("a present summary becomes its own category", cats2.some((c) => c.name === "summary" && c.tokens > 0));
}

// --- prior sessions for two different cwds -----------------------------------
try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}
globalThis.fetch = async () => new Response("{}", { status: 200 });
const cwd = "C:/Users/Dominique/dom";
{
  const here = createSession(cwd, "here-model", "ask");
  here.messages = [{ role: "user", text: "earlier work here" }];
  await saveSession(here);
  const there = createSession("C:/some/other/dir", "there-model", "ask");
  there.messages = [{ role: "user", text: "elsewhere" }];
  await saveSession(there);
}

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
const type = async (s) => { for (const ch of s) { send(ch); await wait(10); } await wait(40); };
const allText = () => strip(frames.join("\n"));

const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const engine = new Engine({ apiKey: "test", cwd, systemPrompt: "a system prompt of some length", models: [model], session: createSession(cwd, "m", "ask"), skills: [], autoCommit: false });
engine.messages.push({ role: "user", text: "hello there this is a user message" });

const app = render(
  React.createElement(App, { engine, caps: detectCaps(), width: 100, ghAuth: "-", initialRepo: { branch: null, dirtyCount: 0 }, skillWarnings: [], defaultModel: "m" }),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
);
await wait(120);

// --- /context ---------------------------------------------------------------
await type("/context");
send("\r");
await wait(150);
{
  const txt = allText();
  ok("/context prints a usage header with the window", /context: \d+ tokens used \/ \d+ window/.test(txt));
  ok("/context breaks it down by category", txt.includes("system prompt") && txt.includes("user messages"));
  ok("/context shows percentages", /% of used/.test(txt));
}

// --- /resume (no args) shows only this-cwd sessions -------------------------
await type("/resume");
send("\r");
await wait(200);
{
  const txt = allText();
  ok("/resume lists a prior session for THIS cwd", txt.includes("here-model"));
  ok("/resume excludes sessions from other cwds", !txt.includes("there-model"));
}

try { app.unmount(); } catch {}
try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
