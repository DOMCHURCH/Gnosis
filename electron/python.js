// Finding a Python that has the package you need — shared by every Python-backed
// feature in the shell (openWakeWord, Kokoro).
//
// This lives on its own because it was got wrong twice in the same way. Probing
// only `python` / `py` / `python3` quietly misses real installations on Windows:
// `py` runs the launcher's DEFAULT version, `python` is whatever venv happens to
// be first on PATH, and someone who ran `pip install` from a specific interpreter
// — 3.12 while the default is 3.14 — ends up with the package installed and the
// app insisting it is not. `py -0p` is the authoritative list, so ask it.
//
// The wake-word side learned that the hard way; the TTS side had been copied from
// the earlier, broken version and so could never find the same interpreter the
// wake word was already running on. One module now, so a fix lands in both.

import { execFile } from "node:child_process";

/** Every interpreter on the Windows launcher's list, newest first. [] elsewhere. */
export function launcherPythons() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    execFile("py", ["-0p"], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const paths = [];
      // Lines look like:  -V:3.12          C:\path\to\python.exe
      const LINE = /\s([A-Za-z]:\\[^\s][^\r\n]*?python\.exe)\s*$/i;
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = line.match(LINE);
        if (m) paths.push(m[1]);
      }
      resolve(paths);
    });
  });
}

/** Interpreters to try, in order. GNOSIS_PYTHON wins outright if it is set. */
export async function candidates() {
  // An explicit GNOSIS_PYTHON is a decision, not a hint: if the user pinned an
  // interpreter and it lacks the package, quietly succeeding with a DIFFERENT one
  // hides their mistake and runs code they did not choose.
  if (process.env.GNOSIS_PYTHON) return [process.env.GNOSIS_PYTHON];
  const launcher = await launcherPythons();
  // Dedup while keeping order: the plain names first (they are fast and usually
  // right), then every interpreter the launcher knows about.
  return [...new Set(["python", "py", "python3", ...launcher])];
}

/** The extra args an interpreter needs — `py` is a launcher, not an interpreter. */
export function argsFor(exe) {
  return exe === "py" ? ["-3"] : [];
}

/**
 * The first interpreter that can `import <module>`.
 * @returns { ok, exe, args } or { ok:false, tried } — the caller writes the message,
 * because what to install differs per feature.
 */
export async function findPythonWith(moduleNames) {
  const mods = Array.isArray(moduleNames) ? moduleNames : [moduleNames];
  const tried = [];
  for (const exe of await candidates()) {
    const args = argsFor(exe);
    const ok = await new Promise((resolve) => {
      // Any ONE of the modules is enough: a feature may have more than one usable
      // backend (Kokoro ships as both `kokoro` and `kokoro_onnx`).
      const probe = `import importlib,sys\nfor m in ${JSON.stringify(mods)}:\n    try:\n        importlib.import_module(m); print('ok'); sys.exit(0)\n    except Exception: pass\nsys.exit(1)`;
      execFile(exe, [...args, "-c", probe], { timeout: 20000, windowsHide: true }, (_e, stdout) =>
        resolve(String(stdout ?? "").includes("ok")),
      );
    });
    if (ok) return { ok: true, exe, args };
    tried.push(exe);
  }
  return { ok: false, tried };
}
