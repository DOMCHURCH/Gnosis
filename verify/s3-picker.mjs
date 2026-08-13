// Verify (UI): the Picker's "save as default" secondary action — Ctrl+S triggers
// onSave with the highlighted row, distinct from Enter's onSelect. This is the
// picker path for saving a model as the default. No network.
import React from "react";
import { render } from "ink";
import { EventEmitter } from "node:events";
import { Picker } from "../dist/ui/Picker.js";
import { detectCaps } from "../dist/ui/terminal.js";

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");

const frames = [];
const stdout = new EventEmitter();
stdout.columns = 90; stdout.rows = 30; stdout.isTTY = true;
stdout.write = (s) => { frames.push(s); return true; };

const stdin = new EventEmitter();
stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
stdin.resume = () => {}; stdin.pause = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
const inq = [];
stdin.read = () => (inq.length ? inq.shift() : null);
const send = (s) => { inq.push(s); stdin.emit("readable"); };

let selected = null, saved = null;
const items = [{ value: "a/one", label: "a/one" }, { value: "b/two", label: "b/two" }];
const app = render(
  React.createElement(Picker, {
    caps: detectCaps(), width: 80, title: "select model", items, initialValue: "b/two",
    onSelect: (v) => { selected = v; }, onSave: (v) => { saved = v; }, onCancel: () => {}, saveHint: "save as default",
  }),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
);

await wait(120);
ok("picker shows the ctrl+s save hint in the footer", strip(frames.join("\n")).includes("save as default"));

send(String.fromCharCode(19)); // Ctrl+S (DC3) on the highlighted row ("b/two")
await wait(120);
ok("ctrl+s triggers onSave with the highlighted value", saved === "b/two");
ok("ctrl+s does NOT also trigger onSelect", selected === null);

send("\r"); // Enter
await wait(120);
ok("enter still triggers onSelect", selected === "b/two");

try { app.unmount(); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
