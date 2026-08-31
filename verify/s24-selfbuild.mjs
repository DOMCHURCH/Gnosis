// Verify (self-rebuild on stale) — both the mtime scan in isolation and the REAL
// `dom` binary's startup behaviour: it skips the build when DOM_NO_BUILD is set,
// no-ops when the build is current, and rebuilds + re-execs when source is newer
// than dist/. The stale case runs a real `npm run build`; the touched source file's
// mtime is restored afterward so the repo is left current.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cli = path.join(root, "dist", "cli.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const { newestMtime, isStale } = await import("../dist/selfbuild.js");

// --- newestMtime over a controlled tree --------------------------------------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dom-mtime-"));
await fs.mkdir(path.join(tmp, "a", "b"), { recursive: true });
await fs.writeFile(path.join(tmp, "a", "old.txt"), "x");
await fs.writeFile(path.join(tmp, "a", "b", "new.txt"), "y");
const past = new Date(Date.now() - 60_000);
const future = new Date(Date.now() + 60_000);
fss.utimesSync(path.join(tmp, "a", "old.txt"), past, past);
fss.utimesSync(path.join(tmp, "a", "b", "new.txt"), future, future);
ok("newestMtime finds the newest file recursively", Math.abs(newestMtime(tmp) - future.getTime()) < 2000);
ok("newestMtime of a missing dir is 0", newestMtime(path.join(tmp, "nope")) === 0);
await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});

// --- real binary --------------------------------------------------------------
function run(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "--version"], { env: { ...process.env, ...extraEnv } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // "close", NOT "exit". Both fire, and the difference is exactly this
    // suite's flake: "exit" fires when the process ends, while "close" fires
    // once its stdio streams have been drained. Resolving on "exit" therefore
    // reads `out` and `err` at a moment when trailing output may still be in
    // flight — and every assertion here is on the CONTENT of those buffers
    // ("rebuilding", "gnosis <version>"). The child had done the right thing;
    // the test had simply stopped listening a few milliseconds early, which is
    // why it failed intermittently under load and never in isolation.
    child.on("close", (code) => resolve({ out, err, code }));
  });
}

// Current build (freshly built before verify): no rebuild, prints version.
const fresh = await run({ DOM_NO_BUILD: "" });
ok("a current build starts without rebuilding", !/rebuilding/.test(fresh.err) && /gnosis \d/.test(fresh.out));

// Force staleness by bumping a source file's mtime into the future, then restore.
const marker = path.join(root, "src", "install.ts");
const orig = fss.statSync(marker);
fss.utimesSync(marker, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
try {
  ok("isStale() sees a newer source file", isStale() === true);

  // DOM_NO_BUILD skips the check even when stale.
  const skipped = await run({ DOM_NO_BUILD: "1" });
  ok("DOM_NO_BUILD skips the rebuild when stale", !/rebuilding/.test(skipped.err) && /gnosis \d/.test(skipped.out));

  // Without it, a stale build rebuilds (dim notice on stderr) and re-execs to print
  // the version from the fresh build.
  const rebuilt = await run({ DOM_NO_BUILD: "" });
  ok("a stale build triggers 'rebuilding…' on stderr", /rebuilding/.test(rebuilt.err));
  ok("...and the re-exec'd fresh build still runs (prints version)", /gnosis \d/.test(rebuilt.out) && rebuilt.code === 0);
} finally {
  fss.utimesSync(marker, orig.atime, orig.mtime); // restore so the repo isn't left stale
}

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
