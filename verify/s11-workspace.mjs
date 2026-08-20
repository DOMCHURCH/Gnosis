// Verify (3.2 — multi-root workspaces): with 2+ workspace roots, grep/glob called
// WITHOUT an explicit path search every root and prefix each hit with the root's
// name; a single root (or an explicit path) is unprefixed and scoped as before.
// Also checks engine root management (dedupe, can't remove primary) and that the
// system prompt advertises the roots.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { runGrep } = await import("../dist/tools/grep.js");
const { runGlob } = await import("../dist/tools/glob.js");
const { Engine } = await import("../dist/engine.js");
const { createSession } = await import("../dist/config.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- two roots, each with a matching file -----------------------------------
const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "dom-wsA-"));
const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "dom-wsB-"));
await fs.writeFile(path.join(rootA, "a.txt"), "NEEDLE alpha\n");
await fs.writeFile(path.join(rootB, "b.txt"), "NEEDLE beta\n");
const labelA = path.basename(rootA);
const labelB = path.basename(rootB);

// --- grep spans both roots, prefixed ----------------------------------------
{
  const r = await runGrep({ pattern: "NEEDLE" }, undefined, { cwd: rootA, roots: [rootA, rootB] });
  ok("grep spans root A (prefixed with root name)", r.output.includes(`${labelA}/a.txt:1:`));
  ok("grep spans root B (prefixed with root name)", r.output.includes(`${labelB}/b.txt:1:`));
}

// --- glob spans both roots, prefixed ----------------------------------------
{
  const r = await runGlob({ pattern: "**/*.txt" }, undefined, { cwd: rootA, roots: [rootA, rootB] });
  ok("glob spans root A (prefixed)", r.output.split("\n").some((l) => l.startsWith(`${labelA}/a.txt\t`)));
  ok("glob spans root B (prefixed)", r.output.split("\n").some((l) => l.startsWith(`${labelB}/b.txt\t`)));
}

// --- single root: unprefixed, no leak from the other root -------------------
{
  const r = await runGrep({ pattern: "NEEDLE" }, undefined, { cwd: rootA, roots: [rootA] });
  ok("single root is unprefixed (a.txt:1:...)", /(^|\n)a\.txt:1:/.test(r.output));
  ok("single root doesn't leak the other root's match", !r.output.includes("beta"));
}

// --- explicit path scopes to one root even with multiple roots --------------
{
  const r = await runGrep({ pattern: "NEEDLE", path: "." }, undefined, { cwd: rootA, roots: [rootA, rootB] });
  ok("an explicit path disables spanning (only root A)", r.output.includes("alpha") && !r.output.includes("beta"));
}

// --- engine root management -------------------------------------------------
const model = { id: "m", name: "M", context_length: 200000, pricing: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 }, supported_parameters: ["tools"], input_modalities: ["text"] };
const e = new Engine({ apiKey: "t", cwd: rootA, systemPrompt: "SYS", models: [model], session: createSession(rootA, "m", "ask"), skills: [], autoCommit: false, workspaceRoots: [rootB] });

ok("workspaceRoots seed the engine (primary first)", e.roots.length === 2 && path.resolve(e.roots[0]) === path.resolve(rootA) && path.resolve(e.roots[1]) === path.resolve(rootB));
ok("addRoot rejects a duplicate", e.addRoot(rootB).ok === false);
ok("addRoot rejects a non-directory", e.addRoot(path.join(rootA, "nope-does-not-exist")).ok === false);
ok("removeRoot refuses the primary root", e.removeRoot(rootA).ok === false);
ok("removeRoot drops a secondary root", e.removeRoot(rootB).ok === true && e.roots.length === 1);

// re-add so the system prompt has 2 roots to advertise
e.addRoot(rootB);
const sys = e.currentSystemPrompt();
ok("system prompt advertises the workspace roots", /Workspace roots/.test(sys) && sys.includes(rootB));

for (const d of [rootA, rootB, fake]) { try { await fs.rm(d, { recursive: true, force: true }); } catch {} }
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
