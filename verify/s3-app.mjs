// Verify (UI): boots straight into config.model (no startup picker); /model is
// session-scoped (never writes config) and shows a divergence marker; --save is
// the only path that writes config; tabs still work. Isolated to a fake home.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");
process.env.USERPROFILE = path.join(here, "_fakehome");
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
import { createSession } from "../dist/config.js";
import { detectCaps } from "../dist/ui/terminal.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");

// Deterministic, offline catalog for /model resolution (no real network).
globalThis.fetch = async (url) => {
  if (String(url).includes("/models")) {
    return new Response(JSON.stringify({ data: [
      { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", context_length: 1000000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
      { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", context_length: 200000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200 });
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
const type = async (s) => { for (const ch of s) { send(ch); await wait(14); } await wait(50); };
const key = async (s) => { send(s); await wait(80); };

const models = [
  { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", context_length: 1000000, pricing: { prompt: 0, completion: 0 }, supported_parameters: ["tools"] },
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", context_length: 200000, pricing: { prompt: 0, completion: 0 }, supported_parameters: ["tools"] },
];
const DEFAULT = models[0].id;
const configFile = path.join(process.env.USERPROFILE, ".dom", "config.json");
const readConfig = async () => { try { return JSON.parse(await fs.readFile(configFile, "utf8")); } catch { return null; } };
try { await fs.rm(path.join(process.env.USERPROFILE, ".dom"), { recursive: true, force: true }); } catch {}

const session = createSession(REPO_ROOT, DEFAULT, "ask");
const engine = new Engine({ apiKey: "test", cwd: REPO_ROOT, systemPrompt: "test", models, session, skills: [] });

let app, mountError = null;
try {
  app = render(
    React.createElement(App, { engine, caps: detectCaps(), width: 100, ghAuth: "-", initialRepo: { branch: null, dirtyCount: 0 }, skillWarnings: [], defaultModel: DEFAULT }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
} catch (e) { mountError = e; }

await wait(150);
ok("App mounts without throwing", !mountError && frames.length > 0);
ok("boots straight to the input bar — NO startup model picker", !allText().includes("select model") && (allText().includes("/command") || allText().includes("message")));

// --- /model is session-scoped: switches the session, does NOT write config ---
await type("/model anthropic/claude-sonnet-4.6");
await key(ENTER);
await wait(200);
const afterSwitch = allText();
ok("/model switches the session model (status bar updates)", afterSwitch.includes("Claude Sonnet 4.6"));
ok("status bar shows the divergence marker (dim *)", /Claude Sonnet 4\.6 \*/.test(afterSwitch));
const cfg1 = await readConfig();
ok("/model did NOT write config.model (session-scoped)", cfg1 === null || cfg1.model !== "anthropic/claude-sonnet-4.6");

// --- /model --save writes config.model ---
await type("/model --save anthropic/claude-sonnet-4.6");
await key(ENTER);
await wait(200);
const cfg2 = await readConfig();
ok("/model --save writes config.model (the only path that does)", cfg2 && cfg2.model === "anthropic/claude-sonnet-4.6");
ok("save is announced as '(saved as default)'", allText().includes("saved as default"));

// --- tabs still work ---
await type("/new worker");
await key(ENTER);
await wait(200);
ok("/new opens a second tab", allText().includes("worker"));
await type("/tabs");
await key(ENTER);
await wait(200);
ok("/tabs lists the second tab", /2\.\s*worker/.test(allText()));

// --- /tab does a full-screen switch: clears the screen, shows only that tab ---
{
  const before = frames.length;
  await type("/tab 1");
  await key(ENTER);
  await wait(200);
  ok("/tab clears the screen for a full switch", frames.slice(before).join("").includes("\x1b[2J"));
}

// --- /alltabs tiles every tab (numbered read-only cells) ---
{
  const before = frames.length;
  await type("/alltabs");
  await key(ENTER);
  await wait(200);
  ok("/alltabs enters the split view (clears the screen)", frames.slice(before).join("").includes("\x1b[2J"));
  ok("/alltabs tiles show numbered tab cells (2:worker)", /2:worker/.test(allText()));
  await type("/alltabs");
  await key(ENTER);
  await wait(200); // toggle back to single view
}

try { app?.unmount(); } catch {}
try { await fs.rm(process.env.USERPROFILE, { recursive: true, force: true }); } catch {}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
