// Verify (3.3 — memory bank): the `memory` tool saves durable, project-scoped
// notes under ~/.dom/memory (never the repo); add dedupes, list reads back, clear
// erases; different projects get separate banks; formatMemoryForPrompt produces
// the section that boot injects into the system prompt.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { runMemory } = await import("../dist/tools/memory.js");
const { readMemory, memoryPath, memoryKey, formatMemoryForPrompt, countEntries } = await import("../dist/memory.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const projA = await fs.mkdtemp(path.join(os.tmpdir(), "dom-projA-"));
const projB = await fs.mkdtemp(path.join(os.tmpdir(), "dom-projB-"));
const ctxA = { cwd: projA };

// --- add ---------------------------------------------------------------------
let r = await runMemory({ action: "add", note: "use tabs, not spaces" }, undefined, ctxA);
ok("add saves a note and reports the count", !r.isError && /1 note/.test(r.output));
ok("the bank file lives under ~/.dom/memory (not the repo)", memoryPath(projA).startsWith(path.join(fake, ".dom", "memory")));
ok("the note is stored as a bullet", (await readMemory(projA)) === "- use tabs, not spaces");

// --- dedupe ------------------------------------------------------------------
r = await runMemory({ action: "add", note: "use tabs, not spaces" }, undefined, ctxA);
ok("adding an exact duplicate does not grow the bank", countEntries(await readMemory(projA)) === 1);

// --- second note -------------------------------------------------------------
await runMemory({ action: "add", note: "db migrations live in /migrations" }, undefined, ctxA);
ok("a second distinct note is appended", countEntries(await readMemory(projA)) === 2);

// --- list --------------------------------------------------------------------
r = await runMemory({ action: "list" }, undefined, ctxA);
ok("list reads back both notes", /use tabs/.test(r.output) && /db migrations/.test(r.output));

// --- add with no note errors -------------------------------------------------
r = await runMemory({ action: "add" }, undefined, ctxA);
ok("add with no note is an error", r.isError);

// --- project isolation -------------------------------------------------------
ok("different projects get different bank files", memoryKey(projA) !== memoryKey(projB));
await runMemory({ action: "add", note: "project B only" }, undefined, { cwd: projB });
ok("project B's note does not appear in project A", !(await readMemory(projA)).includes("project B only"));
ok("project A's notes do not appear in project B", !(await readMemory(projB)).includes("use tabs"));

// --- system-prompt injection (the exact fn boot uses) ------------------------
const section = formatMemoryForPrompt(await readMemory(projA));
ok("formatMemoryForPrompt wraps the notes in a Memory bank section", /Memory bank/.test(section) && /use tabs/.test(section));
ok("an empty bank formats to the empty string (nothing injected)", formatMemoryForPrompt("") === "");

// --- clear -------------------------------------------------------------------
r = await runMemory({ action: "clear" }, undefined, ctxA);
ok("clear erases the bank", !r.isError && (await readMemory(projA)) === "");

for (const d of [projA, projB, fake]) { try { await fs.rm(d, { recursive: true, force: true }); } catch {} }
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
