// dom's install root — where its code and shipped assets live — resolved from THIS
// module's own location, never from process.cwd(). This is the crucial split that
// lets `dom` run from anywhere: the INSTALL ROOT (here) is used to build dom and to
// locate the web bundle it serves, while the WORKING DIRECTORY that tools read/write
// against stays process.cwd() (see boot() in startup.ts) so it follows the user
// around. The two are independent and only the second tracks where you invoke dom.
//
// Compiled to dist/install.js, so `import.meta.url` points at .../dist/install.js:
// its directory is dist/, and the install root is dist/'s parent.

import path from "node:path";
import { fileURLToPath } from "node:url";

const distDir = path.dirname(fileURLToPath(import.meta.url)); // .../dist

/** Repo / package root (parent of dist/). Where package.json + src/ + web/ live. */
export const INSTALL_ROOT = path.resolve(distDir, "..");
/** Compiled output directory (.../dist). */
export const DIST_DIR = distDir;
/** The built web bundle dom serves (.../dist/web), independent of the cwd. */
export const WEB_ASSETS_DIR = path.join(distDir, "web");
/** Source trees whose mtimes decide whether the build is stale (see selfbuild.ts). */
export const SRC_DIRS = [path.join(INSTALL_ROOT, "src"), path.join(INSTALL_ROOT, "web", "src")];
