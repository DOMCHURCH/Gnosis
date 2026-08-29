// Verify (desktop app): which directory the app opens into.
//
// The app used to open into ~/Gnosis — an empty scratch folder — so every question
// about "this project" searched a directory with nothing in it and found nothing.
// It now defaults to the Gnosis source tree and takes a configured path from
// Settings → Working directory.
//
// Five sources of truth, two of which can name a directory that no longer exists,
// which is the whole reason this is a tested function rather than a few lines in
// main.js: a stale setting has to fall through to something that works, not strand
// the agent at a path that is not there.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const { resolveRootCwd, defaultProject, usableDir } = await import("../electron/rootcwd.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const home = await fs.mkdtemp(path.join(os.tmpdir(), "dom-home-"));
const project = path.join(home, "dom");      // the default project
const chosen = path.join(home, "chosen");    // what the setting points at
const fallback = path.join(home, "Gnosis");  // the last resort
for (const d of [project, chosen, fallback]) await fs.mkdir(d, { recursive: true });

const base = {
  env: {},
  loadConfig: async () => ({}),
  isPackaged: true,
  cwd: path.join(home, "somewhere-else"),
  home,
  fallbackDir: async () => fallback,
};
const resolve = (over) => resolveRootCwd({ ...base, ...over });

// --- the default ----------------------------------------------------------------
ok("defaultProject is ~/dom", defaultProject(home) === project);
{
  const r = await resolve({});
  ok("a packaged app with no setting opens the default project", r.dir === project && r.source === "default");
}

// --- the setting -----------------------------------------------------------------
{
  const r = await resolve({ loadConfig: async () => ({ appCwd: chosen }) });
  ok("a configured appCwd wins over the default", r.dir === chosen && r.source === "config");
}
{
  // Settings writes an absolute path, but a hand-edited config.json may not.
  const r = await resolve({ loadConfig: async () => ({ appCwd: chosen + path.sep + "." }) });
  ok("a configured path is normalised", r.dir === chosen);
}

// --- GNOSIS_CWD is a pin ----------------------------------------------------------
{
  const r = await resolve({ env: { GNOSIS_CWD: fallback }, loadConfig: async () => ({ appCwd: chosen }) });
  ok("GNOSIS_CWD beats the saved setting", r.dir === fallback && r.source === "env");
}

// --- dev runs from source ---------------------------------------------------------
{
  const r = await resolve({ isPackaged: false, cwd: chosen });
  ok("running from source uses the real cwd", r.dir === chosen && r.source === "dev");
}
{
  // ...but not over an explicit choice: someone who set the directory meant it.
  const r = await resolve({ isPackaged: false, loadConfig: async () => ({ appCwd: project }) });
  ok("the setting still wins in dev", r.dir === project && r.source === "config");
}

// --- paths that are not there ------------------------------------------------------
{
  const gone = path.join(home, "was-renamed");
  const r = await resolve({ loadConfig: async () => ({ appCwd: gone }) });
  ok("a configured path that is missing falls through", r.dir === project && r.source === "default");
}
{
  const file = path.join(home, "notadir.txt");
  await fs.writeFile(file, "x");
  const r = await resolve({ loadConfig: async () => ({ appCwd: file }) });
  ok("a configured path that is a FILE falls through", r.dir === project && r.source === "default");
}
{
  // A machine with no ~/dom: still has to open somewhere.
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "dom-bare-"));
  const r = await resolve({ home: bare });
  ok("no default project falls back to ~/Gnosis", r.dir === fallback && r.source === "fallback");
  await fs.rm(bare, { recursive: true, force: true }).catch(() => {});
}
{
  // A config file that cannot be read must not stop the app booting.
  const r = await resolve({ loadConfig: async () => { throw new Error("corrupt"); } });
  ok("an unreadable config still opens the default", r.dir === project && r.source === "default");
}
{
  const r = await resolve({ loadConfig: undefined });
  ok("no loadConfig at all is survivable", r.dir === project);
}

// --- usableDir ---------------------------------------------------------------------
ok("usableDir accepts a directory", (await usableDir(project)) === true);
ok("usableDir rejects a missing path", (await usableDir(path.join(home, "nope"))) === false);
ok("usableDir rejects a file", (await usableDir(path.join(home, "notadir.txt"))) === false);

await fs.rm(home, { recursive: true, force: true }).catch(() => {});
console.log(fails ? `\n${fails} FAILED` : "\nall app-cwd checks passed");
process.exit(fails ? 1 : 0);
