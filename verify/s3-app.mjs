// Verify 3 (UI): the App mounts with the tab integration and drives real tab
// operations (/new, /tabs) through simulated stdin - catching render/TDZ faults
// that tsc can't. Isolated to a fake home so no real config/session is written.
process.env.USERPROFILE = "C:/Users/Dominique/dom/verify/_fakehome";
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

const frames = [];
const stdout = new EventEmitter();
stdout.columns = 100; stdout.rows = 40; stdout.isTTY = true;
stdout.write = (s) => { frames.push(s); return true; };
const allText = () => strip(frames.join("\n"));

// Ink 5 reads input via the 'readable' event + stdin.read() (NOT 'data').
const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.setRawMode = () => {}; stdin.setEncoding = () => {}; stdin.resume = () => {};
stdin.pause = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
const inq = [];
stdin.read = () => (inq.length ? inq.shift() : null);
const send = (s) => { inq.push(s); stdin.emit("readable"); };

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const key = async (s) => { send(s); await wait(90); };
const type = async (s) => { for (const ch of s) { send(ch); await wait(16); } await wait(60); };

const models = [
  { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", context_length: 1000000, pricing: { prompt: 0, completion: 0 }, supported_parameters: ["tools"] },
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", context_length: 200000, pricing: { prompt: 0, completion: 0 }, supported_parameters: ["tools"] },
];
const session = createSession("C:/Users/Dominique/dom", models[0].id, "ask");
const engine = new Engine({ apiKey: "test", cwd: "C:/Users/Dominique/dom", systemPrompt: "test", models, session, skills: [] });
const caps = detectCaps();

let app, mountError = null;
try {
  app = render(
    React.createElement(App, { engine, caps, width: 100, ghAuth: "-", initialRepo: { branch: null, dirtyCount: 0 }, skillWarnings: [] }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
} catch (e) { mountError = e; }

await wait(150);
ok("App mounts without throwing", !mountError && frames.length > 0);
ok("first frame renders the boot model picker", allText().includes("select model"));

await key(ESC);                 // close the boot model picker
await wait(120);
ok("Esc dismisses the overlay, input bar shows", allText().includes("/command") || allText().includes("message"));

await type("/new worker");      // create + switch to a second tab
await key(ENTER);
await wait(200);
ok("/new opens a second tab (transcript/tab-bar shows 'worker')", allText().includes("worker"));

await type("/tabs");            // list the open tabs
await key(ENTER);
await wait(200);
const afterTabs = allText();
ok("/tabs lists the open tabs", afterTabs.includes("tabs:"));
ok("/tabs shows the second tab 'worker'", /2\.\s*worker/.test(afterTabs));

// The tab bar row is present with both tabs numbered.
ok("tab bar renders both numbered tabs", /1:/.test(afterTabs) && /2:worker/.test(afterTabs));

try { app?.unmount(); } catch {}
try { await fs.rm("C:/Users/Dominique/dom/verify/_fakehome", { recursive: true, force: true }); } catch {}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
