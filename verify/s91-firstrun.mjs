// Verify (first run): the directories Gnosis documents actually get created.
//
// These were only ever created as a side effect — by whichever write happened to
// need one first, and, for ~/Gnosis, by a single caller in the desktop shell
// that fires only when the user has no configured cwd AND no default project.
// A fresh install down any other path had none of it, which matters because the
// paths are named in things the user is shown: the permission gate warns about
// deleting "outside C:\\Users\\you\\Gnosis", bare-filename writes are redirected
// into ~/Gnosis/workspace/<date>/, and ~/.dom/skills is where a user's own
// skills go. A folder that does not exist answers none of those questions.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the home directory BEFORE importing anything that reads it.
const fake = await fs.mkdtemp(path.join(os.tmpdir(), "dom-firstrun-"));
process.env.USERPROFILE = fake;
process.env.HOME = fake;

const { ensureUserDirs } = await import("../dist/firstrun.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const exists = async (p) => !!(await fs.stat(p).catch(() => null));
const isDir = async (p) => (await fs.stat(p).catch(() => null))?.isDirectory() === true;

// --- a genuinely empty home -------------------------------------------------
{
  const created = await ensureUserDirs();
  ok("it reports what it created on a first run", created.length > 0);

  for (const rel of [".dom", ".dom/sessions", ".dom/cache", ".dom/skills"]) {
    ok(`~/${rel} exists`, await isDir(path.join(fake, rel)));
  }
  for (const rel of ["Gnosis", "Gnosis/screenshots", "Gnosis/workspace"]) {
    ok(`~/${rel} exists`, await isDir(path.join(fake, rel)));
  }
  ok("~/.dom/mcp.json is seeded", await exists(path.join(fake, ".dom", "mcp.json")));

  // The registry has to be the real default, not an empty stub — this is the
  // same file the app's MCP connections are read from.
  const reg = JSON.parse(await fs.readFile(path.join(fake, ".dom", "mcp.json"), "utf8"));
  const names = Object.keys(reg.mcpServers ?? {});
  ok("...with the default servers in it", names.length >= 4);
  ok("...including computer-use, so voice can drive the desktop", names.includes("computer-use"));
}

// --- the empty folders explain themselves -----------------------------------
// An empty directory named `skills` tells a user nothing about what to put in
// it. These are the only content written, and only into folders just created.
{
  for (const rel of [".dom/skills", "Gnosis/workspace", "Gnosis/screenshots"]) {
    const readme = path.join(fake, rel, "README.md");
    ok(`~/${rel} carries a README`, await exists(readme));
    const txt = await fs.readFile(readme, "utf8").catch(() => "");
    ok(`...that says what the folder is for`, txt.length > 40);
  }
}

// --- idempotent, and non-destructive ----------------------------------------
{
  // Put something in the tree, then run again: nothing may be clobbered.
  const mine = path.join(fake, "Gnosis", "workspace", "keep.txt");
  await fs.writeFile(mine, "user data", "utf8");
  const custom = path.join(fake, ".dom", "skills", "README.md");
  await fs.writeFile(custom, "my own notes", "utf8");

  const second = await ensureUserDirs();
  ok("a second run creates nothing", second.length === 0);
  ok("...and leaves user files alone", (await fs.readFile(mine, "utf8")) === "user data");
  // The README is only written for a folder this run created, so an edited one
  // survives — otherwise every launch would overwrite the user's own notes.
  ok("...including a README the user has edited", (await fs.readFile(custom, "utf8")) === "my own notes");

  // An existing mcp.json must never be replaced with the defaults: that would
  // silently drop every server the user added.
  const reg = path.join(fake, ".dom", "mcp.json");
  await fs.writeFile(reg, JSON.stringify({ mcpServers: { mine: { command: "x" } } }), "utf8");
  await ensureUserDirs();
  const after = JSON.parse(await fs.readFile(reg, "utf8"));
  ok("an existing MCP registry is never overwritten", Object.keys(after.mcpServers).join() === "mine");
}

// --- it must not throw on a home it cannot write ----------------------------
// A read-only or redirected profile is not a reason to refuse to start.
{
  process.env.USERPROFILE = path.join(fake, "nope", "\0bad");
  process.env.HOME = process.env.USERPROFILE;
  let threw = false;
  try { await ensureUserDirs(); } catch { threw = true; }
  ok("an unwritable home is survived, not thrown on", threw === false);
  process.env.USERPROFILE = fake;
  process.env.HOME = fake;
}

// --- boot() calls it --------------------------------------------------------
// The whole point is that it runs on every start, before the API-key check that
// can throw — a user with no key yet is exactly a user on their first launch.
{
  const src = await fs.readFile(new URL("../src/startup.ts", import.meta.url), "utf8");
  ok("boot() runs the scaffolding", /await ensureUserDirs\(\)/.test(src));
  const bootBody = src.slice(src.indexOf("export async function boot("));
  ok("...before the API-key check that can throw",
    bootBody.indexOf("ensureUserDirs()") < bootBody.indexOf("No OpenRouter API key found"));
}

try { await fs.rm(fake, { recursive: true, force: true }); } catch {}
console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
