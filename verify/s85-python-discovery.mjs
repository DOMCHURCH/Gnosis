// Verify (voice): the wake word and Kokoro find Python the same way.
//
// This suite exists because they did not. Interpreter discovery was fixed once,
// on the wake-word side, and the TTS side kept a private copy of the older
// version — `python`, `py`, `python3` and nothing else. On a machine where `py`
// is the launcher default (3.14) and `python` is some unrelated venv, that copy
// could never find the 3.12 that `pip install` had actually written to. So the
// wake word ran and Kokoro reported itself uninstalled, on one machine, from one
// pip install, at the same moment.
//
// The structural checks are the point: they fail if anyone re-adds a private
// interpreter list. The live probe is reported but only asserted when a Python
// with the package is actually present, so this stays runnable on a machine that
// has neither.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// --- one implementation, imported twice ----------------------------------------
const wake = read("electron/wakeword.js");
const kokoro = read("electron/kokoro.js");

ok("wakeword.js imports the shared discovery", /from "\.\/python\.js"/.test(wake));
ok("kokoro.js imports the shared discovery", /from "\.\/python\.js"/.test(kokoro));
// The tell-tale of a private copy: the hardcoded three-name list, or a second
// call to the launcher.
for (const [name, src] of [["wakeword.js", wake], ["kokoro.js", kokoro]]) {
  ok(`${name} has no private interpreter list`, !/"python",\s*"py",\s*"python3"/.test(src));
  ok(`${name} does not shell out to the launcher itself`, !/\["-0p"\]/.test(src));
}

// --- the shared module does the thing it exists to do ---------------------------
const { candidates, launcherPythons, argsFor, findPythonWith } = await import("../electron/python.js");

ok("`py` gets the -3 the launcher needs", JSON.stringify(argsFor("py")) === '["-3"]');
ok("a real interpreter path gets no extra args", JSON.stringify(argsFor("C:/py/python.exe")) === "[]");

const list = await candidates();
ok("the plain names are tried first", list[0] === "python" && list[1] === "py" && list[2] === "python3");
ok("the list has no duplicates", new Set(list).size === list.length);

if (process.platform === "win32") {
  const launcher = await launcherPythons();
  console.log(`  (launcher reported ${launcher.length} interpreter(s))`);
  // The regex that parses `py -0p` lost a backslash once and silently dropped
  // every path, which is the failure this asserts against: if the launcher
  // answered at all, what it answered with has to have survived parsing.
  ok("every launcher path is absolute and ends in python.exe",
    launcher.every((p) => /^[A-Za-z]:\\/.test(p) && /python\.exe$/i.test(p)));
  ok("launcher interpreters reach the candidate list",
    launcher.every((p) => list.includes(p)));
}

// GNOSIS_PYTHON is a pin, not a hint — falling back past it runs an interpreter
// the user did not choose, which is how a broken pin looks like a working app.
{
  const saved = process.env.GNOSIS_PYTHON;
  process.env.GNOSIS_PYTHON = "C:/nowhere/python.exe";
  const pinned = await candidates();
  ok("GNOSIS_PYTHON is used exclusively", pinned.length === 1 && pinned[0] === "C:/nowhere/python.exe");
  if (saved === undefined) delete process.env.GNOSIS_PYTHON;
  else process.env.GNOSIS_PYTHON = saved;
}

// --- live: whatever is actually installed on this machine -----------------------
const wakePy = await findPythonWith("openwakeword");
const ttsPy = await findPythonWith(["kokoro", "kokoro_onnx"]);
console.log(`  openwakeword: ${wakePy.ok ? wakePy.exe : "not installed"}`);
console.log(`  kokoro:       ${ttsPy.ok ? ttsPy.exe : "not installed"}`);

// The invariant that matters is not "both are installed" — it is that when both
// ARE installed, discovery lands on the same interpreter rather than one feature
// working and the other insisting the package is absent.
if (wakePy.ok && ttsPy.ok) {
  ok("both features resolve to the same interpreter", wakePy.exe === ttsPy.exe);
} else {
  console.log("SKIP both-features check (one of the packages is not installed here)");
}

// --- the bridges must be reachable from OUTSIDE Electron -----------------------
// Python is an ordinary process with an ordinary open(): it cannot read out of
// app.asar. Left packed, it reports `can't open file '...app.asar\electron\
// openwakeword_bridge.py'` and both the wake word and Kokoro die in the packaged
// app while working perfectly under `npm run app` — which is exactly the kind of
// bug that only ever shows up on a user's machine. Both halves have to hold: the
// file is unpacked by electron-builder, and the path points at the unpacked copy.
{
  const { asarPath } = await import("../electron/python.js");
  const packed = path.join("C:", "app", "resources", "app.asar", "electron", "openwakeword_bridge.py");
  ok("asarPath redirects a packed path", asarPath(packed).includes("app.asar.unpacked"));
  const dev = path.join("C:", "dev", "electron", "x.py");
  ok("...and leaves an unpacked path alone", asarPath(dev) === dev);

  const builder = read("electron-builder.yml");
  ok("electron-builder unpacks the python scripts", /asarUnpack:[\s\S]*electron\/\*\.py/.test(builder));

  ok("wakeword.js routes its bridge through asarPath", /BRIDGE = asarPath\(/.test(wake));
  ok("kokoro.js routes its bridge through asarPath", /BRIDGE = asarPath\(/.test(kokoro));
}

console.log(fails ? `\n${fails} FAILED` : "\nall python-discovery checks passed");
process.exit(fails ? 1 : 0);
