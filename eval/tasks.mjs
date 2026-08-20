// The regression eval task suite: 10 fixed tasks, each run in its own scratch
// repo. A task is { name, setup(dir), prompt, check(dir, output) -> bool }. The
// check is OUTCOME-based (final file state or the model's answer text), so any
// correct approach passes — it is not tied to a particular tool sequence.
//
// `solution` is used ONLY by the offline mock in verify/s7-eval.mjs to replay a
// known-good tool trajectory deterministically; the real harness ignores it.

import { promises as fs } from "node:fs";
import path from "node:path";

const read = (dir, f) => fs.readFile(path.join(dir, f), "utf8");
const write = (dir, f, c) => fs.writeFile(path.join(dir, f), c);

export const TASKS = [
  {
    name: "write-file",
    async setup() {},
    prompt: "Create a file named hello.txt whose exact contents are: hello world",
    async check(dir) {
      try { return (await read(dir, "hello.txt")).trim() === "hello world"; } catch { return false; }
    },
    solution: { calls: [{ tool: "write", args: { path: "hello.txt", content: "hello world" } }], answer: "Created hello.txt." },
  },
  {
    name: "edit-const",
    async setup(dir) { await write(dir, "config.js", "export const VERSION = 1;\n"); },
    prompt: "In config.js, change VERSION from 1 to 2.",
    async check(dir) {
      try { return /VERSION\s*=\s*2/.test(await read(dir, "config.js")); } catch { return false; }
    },
    solution: { calls: [{ tool: "read", args: { path: "config.js" } }, { tool: "edit", args: { path: "config.js", old_str: "VERSION = 1", new_str: "VERSION = 2" } }], answer: "Updated VERSION to 2." },
  },
  {
    name: "answer-number",
    async setup(dir) { await write(dir, "secret.txt", "The access code is 42.\n"); },
    prompt: "Read secret.txt and reply with just the access code number.",
    async check(_dir, output) { return /\b42\b/.test(output); },
    solution: { calls: [{ tool: "read", args: { path: "secret.txt" } }], answer: "42" },
  },
  {
    name: "rename-function",
    async setup(dir) { await write(dir, "math.js", "function add(a, b) { return a + b; }\nconst r = add(1, 2);\n"); },
    prompt: "Rename the function add to sum everywhere in math.js.",
    async check(dir) {
      try { const c = await read(dir, "math.js"); return /function sum/.test(c) && /sum\(1, 2\)/.test(c) && !/\badd\b/.test(c); } catch { return false; }
    },
    solution: { calls: [{ tool: "read", args: { path: "math.js" } }, { tool: "edit", args: { path: "math.js", old_str: "add", new_str: "sum", replace_all: true } }], answer: "Renamed add to sum." },
  },
  {
    name: "grep-locate",
    async setup(dir) {
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      await write(dir, "src/a.js", "export function foo() { return 1; }\n");
      await write(dir, "src/b.js", "import { foo } from './a.js';\nfoo();\n");
    },
    prompt: "Which file DEFINES the function foo? Reply with just the file path.",
    async check(_dir, output) { return /a\.js/.test(output) && !/b\.js/.test(output); },
    solution: { calls: [{ tool: "grep", args: { pattern: "function foo" } }], answer: "src/a.js" },
  },
  {
    name: "add-function",
    async setup(dir) { await write(dir, "util.js", "export const PI = 3.14;\n"); },
    prompt: "Add an exported function double(n) that returns n * 2 to util.js. Keep the existing content.",
    async check(dir) {
      try { const c = await read(dir, "util.js"); return /PI = 3\.14/.test(c) && /function double/.test(c) && /n\s*\*\s*2/.test(c); } catch { return false; }
    },
    solution: { calls: [{ tool: "read", args: { path: "util.js" } }, { tool: "edit", args: { path: "util.js", old_str: "export const PI = 3.14;", new_str: "export const PI = 3.14;\nexport function double(n) { return n * 2; }" } }], answer: "Added double()." },
  },
  {
    name: "fix-typo-bug",
    async setup(dir) { await write(dir, "greet.js", "export function greet(name) { return 'Hello, ' + naem; }\n"); },
    prompt: "There is a bug in greet.js: a misspelled variable. Fix it so the function works.",
    async check(dir) {
      try { const c = await read(dir, "greet.js"); return /\+ name\b/.test(c) && !/naem/.test(c); } catch { return false; }
    },
    solution: { calls: [{ tool: "read", args: { path: "greet.js" } }, { tool: "edit", args: { path: "greet.js", old_str: "naem", new_str: "name" } }], answer: "Fixed the typo." },
  },
  {
    name: "create-json",
    async setup() {},
    prompt: 'Create config.json containing a JSON object with a field "name" set to "dom".',
    async check(dir) {
      try { return JSON.parse(await read(dir, "config.json")).name === "dom"; } catch { return false; }
    },
    solution: { calls: [{ tool: "write", args: { path: "config.json", content: '{\n  "name": "dom"\n}\n' } }], answer: "Created config.json." },
  },
  {
    name: "delete-line",
    async setup(dir) { await write(dir, "list.txt", "alpha\nbeta\ngamma\n"); },
    prompt: "Remove the line containing 'beta' from list.txt, leaving the other lines unchanged.",
    async check(dir) {
      try {
        // Semantic check: exactly the two remaining lines in order, no blank line
        // left where beta was. Tolerates a trailing-newline difference (which made
        // an exact full-file match flaky against a non-deterministic model) but
        // still rejects a leftover blank line or a lingering "beta".
        const raw = await read(dir, "list.txt");
        const lines = raw.split("\n");
        if (lines[lines.length - 1] === "") lines.pop(); // drop a single trailing newline
        return lines.length === 2 && lines[0] === "alpha" && lines[1] === "gamma";
      } catch {
        return false;
      }
    },
    solution: { calls: [{ tool: "read", args: { path: "list.txt" } }, { tool: "edit", args: { path: "list.txt", old_str: "beta\n", new_str: "" } }], answer: "Removed the beta line." },
  },
  {
    name: "count-answer",
    async setup(dir) { await write(dir, "words.txt", "cat dog cat bird cat\n"); },
    prompt: "Count how many times the word 'cat' appears in words.txt and reply with just the number.",
    async check(_dir, output) { return /\b3\b/.test(output); },
    solution: { calls: [{ tool: "read", args: { path: "words.txt" } }], answer: "3" },
  },
];
