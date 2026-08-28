// Verify (write scope): new files land only in ~/Gnosis, the Gnosis source
// checkout is read-only, edits and deletes elsewhere still work, and a delete
// outside the sandbox always stops for confirmation — even in yolo.
import os from "node:os";
import path from "node:path";
import { promises as fs, existsSync } from "node:fs";

const { scopeDecision, scopeViolation, writeOpFor, bashScopeViolation, inSandbox, inSource, sourceDir, hasProjectContext, isDeletingCommand, isMutatingCommand, commandPaths } =
  await import("../dist/writescope.js");
const { gate } = await import("../dist/permissions.js");
const { gnosisDir } = await import("../dist/workspace.js");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

const HOME = os.homedir();
const SANDBOX = gnosisDir();
const SRC = sourceDir();
// A real repo on disk (a .git dir is enough) and a real directory with no project
// above it — the create rule turns on exactly this distinction.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "scope-"));
const PROJ = path.join(TMP, "repo");
const LOOSE = path.join(TMP, "loose");
await fs.mkdir(path.join(PROJ, ".git"), { recursive: true });
await fs.mkdir(path.join(PROJ, "src"), { recursive: true });
await fs.mkdir(LOOSE, { recursive: true });

// --- the three zones ----------------------------------------------------------
ok("~/Gnosis is the sandbox", inSandbox(path.join(SANDBOX, "workspace", "x.js")));
ok("~/dom is the source", inSource(path.join(SRC, "src", "engine.ts")));
ok("a project is neither", !inSandbox(PROJ) && !inSource(PROJ));
ok("a sibling sharing the prefix is NOT the source", !inSource(HOME + path.sep + "dom-notes"));

// --- creates ------------------------------------------------------------------
ok("a new file in the sandbox is allowed", scopeViolation("create", path.join(SANDBOX, "race-car.html")) === null);
ok("a repo is a project", hasProjectContext(PROJ) && hasProjectContext(path.join(PROJ, "src")));
ok("a loose directory is not", !hasProjectContext(LOOSE));
ok("a new file INSIDE a repo is allowed outright", scopeDecision("create", path.join(PROJ, "src", "Card.tsx")).kind === "ok");
ok("...anywhere in it", scopeDecision("create", path.join(PROJ, "race-car.html")).kind === "ok");
ok("a new file with NO project around it asks first", scopeDecision("create", path.join(LOOSE, "stray.js")).kind === "confirm");
ok("...naming the sandbox as where it belongs", scopeDecision("create", path.join(LOOSE, "stray.js")).reason.includes(SANDBOX));
ok("a new file in the sandbox needs no confirmation", scopeDecision("create", path.join(SANDBOX, "x.html")).kind === "ok");
ok("a new file in the source is refused", !!scopeViolation("create", path.join(SRC, "smoke.js")));
ok("...as source, not as scatter", (scopeViolation("create", path.join(SRC, "smoke.js")) || "").includes("read-only"));

// --- edits --------------------------------------------------------------------
ok("editing an existing project file is allowed", scopeViolation("edit", path.join(PROJ, "src", "index.js")) === null);
ok("editing the sandbox is allowed", scopeViolation("edit", path.join(SANDBOX, "notes.md")) === null);
ok("editing the source is REFUSED", !!scopeViolation("edit", path.join(SRC, "src", "engine.ts")));
ok("...including its verify suites", !!scopeViolation("edit", path.join(SRC, "verify", "s1-models.mjs")));

// --- deletes ------------------------------------------------------------------
ok("deleting in a project is allowed", scopeViolation("delete", path.join(PROJ, "old.js")) === null);
ok("deleting elsewhere on the machine is allowed", scopeViolation("delete", path.join(HOME, "Downloads", "junk.zip")) === null);
ok("deleting in the sandbox is allowed", scopeViolation("delete", path.join(SANDBOX, "tmp.js")) === null);
ok("deleting from the source is REFUSED", !!scopeViolation("delete", path.join(SRC, "package.json")));

// --- write vs create is decided by what is on disk ----------------------------
ok("an existing path is an edit", writeOpFor(process.argv[1]) === "edit");
ok("a missing path is a create", writeOpFor(path.join(HOME, "definitely-not-here-9f3a.js")) === "create");

// --- bash ---------------------------------------------------------------------
ok("rm is a deleting command", isDeletingCommand("rm -rf build"));
ok("git clean counts as deleting", isDeletingCommand("git clean -fd"));
ok("grep is not mutating", !isMutatingCommand("grep -rn foo src/"));
ok("a redirect is mutating", isMutatingCommand("echo hi > out.txt"));
ok("sed -i is mutating", isMutatingCommand("sed -i 's/a/b/' f.ts"));

ok("a mutating bash command aimed at the source is refused", !!bashScopeViolation(`rm ${SRC}/src/engine.ts`, HOME));
ok("...via a relative path from inside it too", !!bashScopeViolation("rm src/engine.ts", SRC));
ok("...and via a redirect", !!bashScopeViolation(`echo x > ${SRC}/notes.txt`, HOME));
ok("READING the source over bash is untouched", bashScopeViolation(`grep -rn foo ${SRC}/src`, HOME) === null);
ok("cat-ing a source file is untouched", bashScopeViolation(`cat ${SRC}/package.json`, HOME) === null);
ok("mutating a project is allowed", bashScopeViolation(`rm ${PROJ}/old.js`, HOME) === null);
ok("mutating the sandbox is allowed", bashScopeViolation(`rm ${SANDBOX}/tmp.js`, HOME) === null);

// --- the command name is not a file in the cwd --------------------------------
// Every bare word used to be resolved against the cwd, so running ANY mutating
// command from inside the source checkout matched "$SRC/mkdir" and was refused —
// which blocked mkdir, mv and cat outright and left the agent with no shell.
ok("mkdir elsewhere is not blocked by its own command name",
  bashScopeViolation(`mkdir -p ${SANDBOX}`, SRC) === null);
ok("mv between two paths outside the source is allowed from inside it",
  bashScopeViolation(`mv ${SANDBOX}/a ${SANDBOX}/b.html`, SRC) === null);
ok("cat piped to a redirect outside the source is allowed",
  bashScopeViolation(`cat ${SANDBOX}/a > ${SANDBOX}/b.html`, SRC) === null);
ok("a subcommand is not a path", commandPaths("git checkout master", SRC).every((p) => !/master$/.test(p)));
ok("a bare filename with an extension IS a path", commandPaths("rm build.js", PROJ).some((p) => p === path.join(PROJ, "build.js")));
ok("the command name after && is dropped too",
  bashScopeViolation(`ls ${SANDBOX} && mkdir ${SANDBOX}/x`, SRC) === null);
// ...but a real write into the source, however it is spelled, still stops.
ok("a relative write into the source is still refused", !!bashScopeViolation("rm ./src/engine.ts", SRC));
ok("an existing bare file in the source is still refused", !!bashScopeViolation("rm package.json", SRC));

// --- Git Bash absolute paths --------------------------------------------------
// The bash tool resolves to Git Bash on Windows, whose paths are /c/Users/...
// Untranslated they resolve to C:\c\Users\... — under no guarded root, so a write
// into the source went straight through the check.
if (process.platform === "win32") {
  const msys = "/" + SRC[0].toLowerCase() + SRC.slice(2).replace(/\\/g, "/");
  ok("an MSYS path into the source is refused", !!bashScopeViolation(`rm ${msys}/src/engine.ts`, HOME));
  ok("an MSYS path outside it is allowed", bashScopeViolation(`rm /c/Users/nobody/tmp.js`, HOME) === null);
}

// --- the gate, in yolo (where nothing else would stop it) ---------------------
const ctx = (cwd) => ({ cwd, mode: "yolo", approvals: new Set() });
const T = {
  write: { name: "write", mutating: true },
  edit: { name: "edit", mutating: true },
  bash: { name: "bash", mutating: true },
  read: { name: "read", mutating: false },
};

ok("yolo writes a new file into a repo without asking",
  gate(T.write, { path: path.join(PROJ, "race-car.html") }, ctx(PROJ)).kind === "allow");
const stray = gate(T.write, { path: path.join(LOOSE, "stray.js") }, ctx(LOOSE));
ok("yolo still stops for a loose new file", stray.kind === "prompt" && stray.dangerous === true);
ok("...telling the user where it would land", /stray\.js/.test(stray.reason || ""));
ok("yolo still rejects editing the source",
  gate(T.edit, { path: path.join(SRC, "src", "engine.ts") }, ctx(SRC)).kind === "reject");
ok("yolo still rejects rm inside the source",
  gate(T.bash, { command: "rm src/engine.ts" }, ctx(SRC)).kind === "reject");
ok("READING the source is allowed in the gate",
  gate(T.read, { path: path.join(SRC, "src", "engine.ts") }, ctx(SRC)).kind === "allow");
ok("a write into the sandbox is allowed",
  gate(T.write, { path: path.join(SANDBOX, "x.html") }, ctx(PROJ)).kind === "allow");

// A bare filename from the source dir is redirected into the sandbox by the write
// tool — the gate must judge the redirected path, not reject the un-redirected one.
ok("a bare filename from the source dir is NOT rejected (it redirects to the sandbox)",
  gate(T.write, { path: "notes.md" }, ctx(SRC)).kind !== "reject");

// Deleting outside the sandbox is allowed but always stops for a look.
const del = gate(T.bash, { command: `rm ${PROJ}/old.js` }, ctx(PROJ));
ok("deleting outside the sandbox prompts even in yolo", del.kind === "prompt" && del.dangerous === true);
ok("...and says why", /no undo|committed to git/.test(del.reason || ""));
const delIn = gate(T.bash, { command: `rm ${SANDBOX}/tmp.js` }, ctx(SANDBOX));
ok("deleting inside the sandbox needs no ceremony", delIn.kind === "allow");

// A deletion of a git-tracked file is called out as such.
const tracked = gate(T.bash, { command: `rm ${path.join(SRC, "..", "dom-x")}/nope.js` }, ctx(HOME));
ok("a non-existent path still warns rather than crashing", tracked.kind === "prompt");

// A create outside the sandbox is INFORMATIONAL: it stops a session with a user in
// it, but must not refuse a headless run — that would stop `dom -p` writing files.
const info = gate(T.write, { path: path.join(LOOSE, "new.js") }, ctx(LOOSE));
ok("a loose create allows itself headlessly", info.nonInteractive === "allow");
const srcWrite = gate(T.write, { path: path.join(SRC, "new.js") }, ctx(SRC));
ok("a create in the SOURCE is still a flat reject, headless or not", srcWrite.kind === "reject");
const homeWrite = gate(T.write, { path: path.join(HOME, "loose.js") }, ctx(HOME));
ok("writing into the home dir still refuses headlessly", homeWrite.kind === "prompt" && homeWrite.nonInteractive !== "allow");

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
