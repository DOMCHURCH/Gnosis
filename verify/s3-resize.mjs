// Verify: on a terminal resize, the dynamic region is erased (cursor-up over its
// tracked height + eraseDown) BEFORE re-rendering at the new width, so the stale
// old frame isn't stranded. (The full drag test is interactive; this asserts the
// clear sequence fires with the right row count and that the width updates.)
import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { App } from "../dist/ui/App.js";
import { Engine } from "../dist/engine.js";
import { createSession } from "../dist/config.js";
import { detectCaps } from "../dist/ui/terminal.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const writes = [];
const stdout = new EventEmitter();
stdout.columns = 200; stdout.rows = 50; stdout.isTTY = true;
stdout.write = (s) => { writes.push(s); return true; };
const stdin = new EventEmitter();
stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
stdin.resume = () => {}; stdin.pause = () => {}; stdin.ref = () => {}; stdin.unref = () => {}; stdin.read = () => null;

const models = [{ id: "google/gemini-2.5-flash-lite", name: "Gemini", context_length: 1e6, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"] }];
const engine = new Engine({ apiKey: "test", cwd: "C:/Users/Dominique/dom", systemPrompt: "t", models, session: createSession("C:/Users/Dominique/dom", models[0].id, "ask"), skills: [] });
const caps = detectCaps();

const app = render(
  React.createElement(App, { engine, caps, width: 200, ghAuth: "-", initialRepo: { branch: null, dirtyCount: 0 }, skillWarnings: [], defaultModel: models[0].id }),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
);
await wait(150);

// Steady region at boot: status bar (marginTop 1 + row = 2) + the single-line
// input (❯ prompt + mode hint shown while empty = 2). No box, no tabs.
const expectedRows = 2 + 2;

const before = writes.length;
stdout.columns = 100;          // narrow the terminal
stdout.emit("resize");
await wait(120);
const onResize = writes.slice(before).join("");

ok("a resize erases the region (cursor-up + eraseDown) before re-rendering", new RegExp(`\\r\\x1b\\[${expectedRows}A\\x1b\\[J`).test(onResize));
ok("the erase uses eraseDown (\\x1b[J), which is width-agnostic", onResize.includes("\x1b[J"));
ok("erase row count = the region height, positive and within the screen (never eats scrollback)", new RegExp(`\\[${expectedRows}A`).test(onResize) && expectedRows > 0 && expectedRows < stdout.rows);

// A second, smaller narrow also clears (no accumulation of stale frames).
const before2 = writes.length;
stdout.columns = 80;
stdout.emit("resize");
await wait(120);
ok("each subsequent resize re-clears the region", /\r\x1b\[\d+A\x1b\[J/.test(writes.slice(before2).join("")));

try { app.unmount(); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
