// First-run scaffolding: the directories Gnosis documents but never created.
//
// This existed only by accident before. ~/.dom/sessions, ~/.dom/skills and
// ~/.dom/cache were each created lazily by whichever piece of code first needed
// to write into one, and ~/Gnosis was created by exactly one caller — the
// desktop app's working-directory fallback, which only fires when the user has
// NO configured cwd and NO default project. Anyone whose first launch took a
// different branch ended up with none of it.
//
// That is a real problem rather than an untidy one, because these paths are
// load-bearing in things the user is shown:
//
//   - the permission gate names ~/Gnosis in its messages ("deletes files outside
//     C:\Users\you\Gnosis — there is no undo"), so a user who goes to look at
//     that folder after reading the warning finds nothing there;
//   - `write` with a bare filename redirects into ~/Gnosis/workspace/<date>/,
//     which is impossible to discover if the tree does not exist;
//   - screenshots land in ~/Gnosis/screenshots;
//   - ~/.dom/skills is where user skills go, and an absent folder reads as "this
//     build does not support skills" rather than "you have not written one".
//
// A directory that exists and is empty answers "where does my stuff go?". A
// directory that does not exist answers nothing.
//
// Everything here is best-effort and never throws: a read-only home directory,
// a redirected profile or a locked-down corporate machine must not stop the
// agent from starting. Callers get the list of what was created, for logging.

import { promises as fs } from "node:fs";
import path from "node:path";
import { cacheDir, domDir, sessionsDir, skillsDir } from "./config.js";
import { gnosisDir, screenshotsDir } from "./workspace.js";
import { ensureMcpConfig } from "./mcp/config.js";

/** A short note dropped into an otherwise-empty folder, so the folder explains
 * itself to someone who opens it in Explorer wondering what it is for. */
const READMES: Record<string, string> = {
  skills: [
    "# Skills",
    "",
    "Drop a skill in here as `<name>/SKILL.md` and Gnosis will load it at start.",
    "The front matter needs a `name` and a `description`; the body is the",
    "instructions. Gnosis reads this folder on every launch, so a new skill is",
    "picked up by restarting.",
    "",
  ].join("\n"),
  workspace: [
    "# Workspace",
    "",
    "Files written without a path land here, in a folder per day, rather than",
    "wherever the shell happened to be pointing. Safe to clear out.",
    "",
  ].join("\n"),
  screenshots: [
    "# Screenshots",
    "",
    "Every image a tool hands back is saved here — screen captures, camera",
    "frames, and images returned by MCP servers. Safe to clear out.",
    "",
  ].join("\n"),
};

/** Create `dir`, and drop `README.md` in it if the folder is newly made. */
async function ensureDir(dir: string, readmeKey?: string): Promise<boolean> {
  try {
    // `recursive: true` resolves to the created path, or undefined when the
    // directory was already there — which is exactly the "is this new?" signal,
    // without a separate stat and its race.
    const made = await fs.mkdir(dir, { recursive: true });
    if (made === undefined) return false;
    const readme = readmeKey ? READMES[readmeKey] : undefined;
    if (readme) await fs.writeFile(path.join(dir, "README.md"), readme, "utf8").catch(() => {});
    return true;
  } catch {
    return false; // read-only home, redirected profile, locked-down machine
  }
}

/**
 * Create the directory tree Gnosis assumes, and seed ~/.dom/mcp.json.
 *
 * Idempotent and safe to call on every boot: an existing tree costs a handful of
 * mkdir calls that immediately no-op. Never throws.
 *
 * Returns the paths it actually created, so a first launch can say what it set
 * up and subsequent ones stay silent.
 */
export async function ensureUserDirs(): Promise<string[]> {
  const created: string[] = [];
  const add = async (dir: string, key?: string) => {
    if (await ensureDir(dir, key)) created.push(dir);
  };

  // ~/.dom — private state. The agent is blocked from reading most of it; these
  // three are the pockets it is allowed into (see permissions.ts).
  await add(domDir());
  await add(sessionsDir());
  await add(cacheDir());
  await add(skillsDir(), "skills");

  // ~/Gnosis — the visible workspace. Not hidden, outside every repo, and the
  // one place to look for anything the agent produced.
  await add(gnosisDir());
  await add(screenshotsDir(), "screenshots");
  await add(path.join(gnosisDir(), "workspace"), "workspace");

  // The MCP registry. ensureMcpConfig() writes the default servers only when the
  // file is absent, so an existing config is never touched.
  try {
    if (await ensureMcpConfig()) created.push(path.join(domDir(), "mcp.json"));
  } catch {
    /* a registry we could not write is not a reason to refuse to start */
  }

  return created;
}
