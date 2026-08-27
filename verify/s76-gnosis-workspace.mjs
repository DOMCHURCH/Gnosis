// Verify (~/Gnosis workspace).
//
// Two rules with sharp edges. Where a write LANDS is the one the user notices
// when it is wrong: redirect too eagerly and a file the user meant to put in
// their project vanishes into a dated folder; too timidly and the home directory
// keeps collecting stray output. The boundary is "did anyone say where" — any
// separator at all means they did.
//
// The redirect is applied in planWrite, which is also what builds the permission
// diff, so the path approved and the path written are the same one. A redirect
// applied after the gate would prompt for one file and write another.
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(path.resolve(here, f)).href);

const W = await imp("../dist/workspace.js");
const { gnosisDir, screenshotsDir, workspaceDir, dayStamp, isScratchCwd, redirectWrite } = W;
const { planWrite } = await imp("../dist/tools/write.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };
const HOME = os.homedir();
const inHome = (...p) => path.join(HOME, ...p);

// --- 1. the folder structure -------------------------------------------------
{
  ok("the workspace root is ~/Gnosis", gnosisDir() === inHome("Gnosis"));
  ok("screenshots live under it", screenshotsDir() === inHome("Gnosis", "screenshots"));
  ok("...and no longer under ~/.dom", !screenshotsDir().includes(".dom"));
  const at = new Date(2026, 7, 27, 13, 5); // local time, 27 Aug 2026
  ok("the day stamp is local-time YYYY-MM-DD", dayStamp(at) === "2026-08-27");
  ok("workspace files are filed by day", workspaceDir(at) === inHome("Gnosis", "workspace", "2026-08-27"));
  // A UTC-based stamp would file an evening write under tomorrow. Check a local
  // time that falls on a different UTC date.
  const late = new Date(2026, 7, 27, 23, 30);
  ok("a late-evening write files under today, not UTC tomorrow", dayStamp(late) === "2026-08-27");
}

// --- 2. which directories count as having no project -------------------------
{
  ok("the home directory is scratch", isScratchCwd(HOME));
  ok("the ~/dom checkout is scratch", isScratchCwd(inHome("dom")));
  ok("a real project directory is not", !isScratchCwd(inHome("projects", "app")));
  ok("a SUBDIRECTORY of ~/dom is not — it is a real place to work", !isScratchCwd(inHome("dom", "src")));
  ok("~/Gnosis itself is not scratch (writing there is already explicit)", !isScratchCwd(gnosisDir()));
}

// --- 3. only a bare filename is redirected -----------------------------------
{
  const at = new Date(2026, 7, 27);
  const day = workspaceDir(at);
  ok("a bare name from home is redirected", redirectWrite(HOME, "notes.md", at) === path.join(day, "notes.md"));
  ok("a bare name from ~/dom is redirected", redirectWrite(inHome("dom"), "notes.md", at) === path.join(day, "notes.md"));
  ok("a bare name from a project is NOT", redirectWrite(inHome("proj"), "notes.md", at) === null);

  // Anything with a separator is the caller saying where.
  ok('"./notes.md" is explicit', redirectWrite(HOME, "./notes.md", at) === null);
  ok('"out/notes.md" is explicit', redirectWrite(HOME, "out/notes.md", at) === null);
  ok("a windows-style relative path is explicit", redirectWrite(HOME, "out" + String.fromCharCode(92) + "notes.md", at) === null);
  ok("an absolute path is untouched", redirectWrite(HOME, inHome("x.md"), at) === null);
  ok("a ~ path is untouched", redirectWrite(HOME, "~/x.md", at) === null);
  ok("an empty path is untouched", redirectWrite(HOME, "", at) === null);
}

// --- 4. planWrite agrees with the redirect (preview == what lands) -----------
{
  const bare = await planWrite({ path: "scratch.md", content: "hi" }, HOME);
  ok("planWrite redirects a bare name from home", bare.absPath.startsWith(inHome("Gnosis", "workspace")));
  ok("...and reports the absolute path, not ../../ from a cwd it left", bare.relPath === bare.absPath);

  const explicit = await planWrite({ path: "sub/scratch.md", content: "hi" }, HOME);
  ok("planWrite leaves an explicit path alone", explicit.absPath === inHome("sub", "scratch.md"));
  ok("...and reports it relative, as before", explicit.relPath === "sub/scratch.md");

  const project = await planWrite({ path: "scratch.md", content: "hi" }, inHome("proj"));
  ok("planWrite leaves a project write alone", project.absPath === inHome("proj", "scratch.md"));

  // The ~/.dom hard block must still bite: it is an absolute path, so no redirect
  // can move it out of the blocked area and quietly make it writable.
  const dom = await planWrite({ path: inHome(".dom", ".env"), content: "x" }, HOME);
  ok("a ~/.dom path is NOT redirected (the hard block still applies to it)", dom.absPath === inHome(".dom", ".env"));
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
