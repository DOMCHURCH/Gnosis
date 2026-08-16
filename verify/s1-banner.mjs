// Verify 1b: the banner carries NO model string. It renders once inside <Static>
// and can't repaint after a mid-session /model switch, so the live model belongs
// only to the status bar. Here we render the Banner in isolation and assert no
// model id / name / provider label appears anywhere in its output.
import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { Banner } from "../dist/ui/Banner.js";
import { TOOL_NAMES } from "../dist/tools/index.js";
import { detectCaps } from "../dist/ui/terminal.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");

const frames = [];
const stdout = new EventEmitter();
stdout.columns = 120; stdout.rows = 40; stdout.isTTY = true;
stdout.write = (s) => { frames.push(s); return true; };
const stdin = new EventEmitter();
stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
stdin.resume = () => {}; stdin.pause = () => {}; stdin.ref = () => {}; stdin.unref = () => {}; stdin.read = () => null;

const app = render(
  React.createElement(Banner, { caps: detectCaps(), width: 120, tools: TOOL_NAMES, ghAuth: "you (gh ok)" }),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
);
await wait(80);
const frame = strip(frames.join("\n"));
try { app.unmount(); } catch {}

ok("banner actually rendered (tools present)", frame.includes("read") && frame.includes("bash"));
ok("banner shows NO active-model id/name", !/gemini|claude|gpt-|deepseek|openrouter/i.test(frame));
ok("banner has no 'model' row label", !/\bmodel\b/i.test(frame));

// Compressed to ~8 rows: the frame is gone (no long horizontal border rule) and
// the tagline + tools + gh fold into ONE dim status line instead of three rows.
ok("banner dropped the frame (no horizontal border rule)", !/─{20,}/.test(frame));
ok("tagline + tools + gh folded into one status line", frame.includes("terminal coding agent") && /\bgh\b/.test(frame));
{
  const rows = frame.split("\n").filter((l) => l.trim().length > 0);
  ok(`banner is ~8 content rows (got ${rows.length})`, rows.length <= 9);
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
