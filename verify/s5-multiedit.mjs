// Verify (feature 3 — multi-edit): edit gains an `edits: [{old_str,new_str,
// replace_all?}]` batch form applied atomically (all-or-nothing), in order, each
// edit's uniqueness checked against the text left by the previous ones, with a
// single COMBINED diff preview. The single-edit form is unchanged. Fake home so
// checkpoints don't touch real ~/.dom.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { planEdit, runEdit } = await import("../dist/tools/edit.js");
const { buildDiffPreview } = await import("../dist/permissions.js");

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; };

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dom-me-"));
const prev = process.cwd();
process.chdir(dir);
const write = (name, content) => fs.writeFile(path.join(dir, name), content);
const read = (name) => fs.readFile(path.join(dir, name), "utf8");

// --- 1) single-edit form is unchanged ---------------------------------------
await write("a.txt", "alpha\nbeta\ngamma\n");
{
  const r = await runEdit({ path: "a.txt", old_str: "beta", new_str: "BETA" });
  ok("single-edit form still applies", !r.isError && (await read("a.txt")) === "alpha\nBETA\ngamma\n");
  ok("single-edit output has no edit-count noise", /1 replacement/.test(r.output) && !/edits/.test(r.output));
}

// --- 2) batch: several edits applied in order -------------------------------
await write("b.txt", "one two three\n");
{
  const r = await runEdit({ path: "b.txt", edits: [
    { old_str: "one", new_str: "1" },
    { old_str: "two", new_str: "2" },
    { old_str: "three", new_str: "3" },
  ] });
  ok("all batch edits apply", !r.isError && (await read("b.txt")) === "1 2 3\n");
  ok("batch output reports edit count + total replacements", /3 edits, 3 replacements/.test(r.output));
}

// --- 3) sequential: a later edit sees an earlier edit's result --------------
await write("c.txt", "foo\n");
{
  const r = await runEdit({ path: "c.txt", edits: [
    { old_str: "foo", new_str: "bar" },
    { old_str: "bar", new_str: "baz" }, // only present AFTER edit 1
  ] });
  ok("later edits operate on earlier edits' output", !r.isError && (await read("c.txt")) === "baz\n");
}

// --- 4) atomic: a failing edit writes nothing -------------------------------
await write("d.txt", "keep me\n");
{
  const before = await read("d.txt");
  const r = await runEdit({ path: "d.txt", edits: [
    { old_str: "keep", new_str: "KEEP" }, // would succeed
    { old_str: "not-present", new_str: "x" }, // fails
  ] });
  ok("a failing edit aborts the batch (points at the offender)", r.isError && /not found.*edit 2\/2/i.test(r.output));
  ok("...and NOTHING is written (atomic all-or-nothing)", (await read("d.txt")) === before);
}

// --- 5) per-edit uniqueness (not unique without replace_all) ----------------
await write("e.txt", "x x x\n");
{
  const r = await runEdit({ path: "e.txt", edits: [{ old_str: "x", new_str: "y" }] });
  ok("a non-unique old_str in a batch is rejected", r.isError && /not unique/i.test(r.output));
  ok("...nothing written", (await read("e.txt")) === "x x x\n");
}

// --- 6) per-edit replace_all -------------------------------------------------
await write("f.txt", "a a b b\n");
{
  const r = await runEdit({ path: "f.txt", edits: [
    { old_str: "a", new_str: "A", replace_all: true },
    { old_str: "b", new_str: "B", replace_all: true },
  ] });
  ok("per-edit replace_all works", !r.isError && (await read("f.txt")) === "A A B B\n");
  ok("...replacement count sums across edits", /4 replacements/.test(r.output));
}

// --- 7) ONE combined diff preview (planEdit doesn't write) ------------------
await write("g.txt", "L1\nL2\nL3\n");
{
  const plan = await planEdit({ path: "g.txt", edits: [
    { old_str: "L1", new_str: "LINE-1" },
    { old_str: "L3", new_str: "LINE-3" },
  ] });
  ok("planEdit returns the combined newContent + editCount", !("error" in plan) && plan.newContent === "LINE-1\nL2\nLINE-3\n" && plan.editCount === 2);
  const preview = buildDiffPreview("edit", plan.relPath, plan.absPath, plan.oldContent, plan.newContent);
  const diffText = preview.lines.map((l) => l.text).join("\n");
  ok("a single combined diff shows BOTH edits", preview.kind === "diff" && /LINE-1/.test(diffText) && /LINE-3/.test(diffText));
  ok("...planEdit is non-destructive (file untouched)", (await read("g.txt")) === "L1\nL2\nL3\n");
}

// --- 8) ambiguity + empty forms are rejected --------------------------------
await write("h.txt", "z\n");
{
  const r = await runEdit({ path: "h.txt", old_str: "z", new_str: "Z", edits: [{ old_str: "z", new_str: "ZZ" }] });
  ok("providing both old_str and edits is rejected", r.isError && /EITHER old_str.*OR edits/i.test(r.output));
  ok("...nothing written", (await read("h.txt")) === "z\n");
  const r2 = await runEdit({ path: "h.txt" });
  ok("neither form provided is rejected", r2.isError && /provide old_str and new_str, or an edits array/i.test(r2.output));
}

process.chdir(prev);
await fs.rm(dir, { recursive: true, force: true });
await fs.rm(fake, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
