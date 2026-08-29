// Which directory the desktop app opens into.
//
// A packaged app is launched from a shortcut, where process.cwd() is wherever
// Explorer happened to be — often system32, never a project. The home directory
// is not the answer either: pointing a repo-indexing agent at all of ~ makes
// boot() take minutes.
//
// This lives apart from main.js for the same reason voicegate.js does: main.js
// reaches for `electron` at module scope and cannot be imported outside a real
// Electron process, and this is the piece with the branching that is actually
// worth testing — five sources of truth, two of which can point at a directory
// that no longer exists.
//
// Everything it depends on is passed in, so the test drives the same function the
// app does rather than a copy of it.

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

/** The default project: the Gnosis source tree.
 *
 * An agent that opens into a real repository can be asked something on the first
 * turn. One that opens into an empty scratch folder answers every question about
 * "this project" with nothing found — which is exactly what defaulting to
 * ~/Gnosis did. */
export function defaultProject(home = os.homedir()) {
  return path.join(home, "dom");
}

/** Is this a directory we can actually work in?
 *
 * A configured path that has since been moved or deleted must not reach boot():
 * the repo map, the file tree and every glob would fail on a root that is not
 * there, and the window would come up looking broken rather than saying so. */
export async function usableDir(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the working directory. Precedence, most explicit first:
 *
 *   1. GNOSIS_CWD          — set deliberately for this launch; always wins
 *   2. config.appCwd       — Settings → Working directory
 *   3. dev: process.cwd()  — running from source, the cwd IS the project
 *   4. ~/dom               — the default project
 *   5. the fallback dir    — ~/Gnosis, the root src/workspace.ts defines for the
 *                            "no project to belong to" case
 *
 * 2 and 4 are checked for existence and fall through when missing, so a stale
 * setting or a machine without ~/dom still gets a window that works rather than
 * an agent rooted at a path that is not there.
 *
 * @param deps.env          the environment to read GNOSIS_CWD from
 * @param deps.loadConfig   async () => Config
 * @param deps.isPackaged   false when running from source
 * @param deps.cwd          process.cwd()
 * @param deps.home         home directory
 * @param deps.fallbackDir  async () => string, created on demand by the caller
 * @param deps.exists       async (dir) => boolean (injectable for tests)
 * @returns { dir, source } — `source` names which rule won, for the log line and
 *          so a test can assert on the REASON rather than only on the path.
 */
export async function resolveRootCwd(deps) {
  const {
    env = process.env,
    loadConfig,
    isPackaged = true,
    cwd = process.cwd(),
    home = os.homedir(),
    fallbackDir,
    exists = usableDir,
  } = deps ?? {};

  if (env.GNOSIS_CWD) return { dir: path.resolve(env.GNOSIS_CWD), source: "env" };

  try {
    const configured = (await loadConfig?.())?.appCwd;
    if (configured) {
      const abs = path.resolve(configured);
      if (await exists(abs)) return { dir: abs, source: "config" };
      // Deliberately falls through rather than failing: a path that was renamed
      // should cost the user a window that opens somewhere sensible, not one that
      // does not open at all. The settings panel shows the live directory beside
      // the configured one, which is where the discrepancy becomes visible.
    }
  } catch {
    /* unreadable config is not a reason to refuse to start */
  }

  if (!isPackaged) return { dir: cwd, source: "dev" };

  const project = defaultProject(home);
  if (await exists(project)) return { dir: project, source: "default" };

  return { dir: await fallbackDir(), source: "fallback" };
}
