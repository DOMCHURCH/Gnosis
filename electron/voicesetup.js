// One-click setup for the two Python-backed voice features.
//
// openWakeWord and Kokoro are both free, both local, and both need no account —
// and neither of them arrives with the app. The installer ships `dist/` and
// `electron/`; it does not ship a Python interpreter, a 310MB ONNX model, or the
// pip packages. Until now the app's entire answer to that was a sentence telling
// the user to go and run `pip install openwakeword` themselves, which meant a
// fresh install had voice input listed in Settings and nothing behind it.
//
// This module is the missing half: given a Python that exists, it installs the
// packages, downloads the wake-word models, and fetches the Kokoro weights into
// ~/.dom/kokoro — reporting each step as it goes, because a silent five-minute
// wait on a 310MB download is indistinguishable from a hang.
//
// What it deliberately does NOT do is install Python. Silently putting a system
// interpreter on someone's machine is not a thing a coding tool should do behind
// a toggle; when none is found this says so and links the download.

import { spawn } from "node:child_process";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { candidates, argsFor } from "./python.js";

const MODEL_DIR = path.join(os.homedir(), ".dom", "kokoro");

/**
 * The Kokoro ONNX weights, from the kokoro-onnx project's own release assets.
 *
 * Pinned to a specific release tag rather than "latest" on purpose: the bridge
 * expects the v1.0 file layout (one model + one voices blob), and a later
 * release that reshapes that would break synthesis for anyone who happened to
 * install on the wrong day. `minBytes` is the expected size, used only to report
 * progress and to reject a truncated download — an HTML error page saved as
 * `kokoro-v1.0.onnx` is the classic failure here, and it fails later, in the
 * bridge, as an unreadable-model error that names the wrong culprit.
 *
 * NO CRYPTOGRAPHIC HASH IS PINNED HERE, and that is a checked fact, not an
 * oversight: neither this release (thewh1teagle/kokoro-onnx model-files-v1.0)
 * nor its own upstream source (taylorchu/kokoro-onnx v0.2.0, which this
 * release's own notes name as where these files come from) publishes a
 * SHA-256 anywhere — GitHub's own asset `digest` field is null on every file
 * in both releases, neither release's notes include a checksums file, and the
 * HuggingFace model card those notes point to (hexgrad/Kokoro-82M, for voice
 * names) carries no hash for this specific packaged asset either. Hashing the
 * file after downloading it from this same URL would only prove the download
 * matched itself, not that it matched anything trustworthy — hashing what you
 * just fetched can't detect a compromise of that same fetch. Until the
 * upstream project publishes an authoritative checksum to pin against, the
 * size floor above plus HTTPS transport are what this can actually verify.
 */
const KOKORO_FILES = [
  {
    name: "kokoro-v1.0.onnx",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    minBytes: 200_000_000,
  },
  {
    name: "voices-v1.0.bin",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
    minBytes: 20_000_000,
  },
];

/** Run a command, streaming its output to `onLine`. Resolves with the exit code. */
function run(exe, args, { onLine, timeout = 900_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeout);
    const feed = (buf) => {
      const s = String(buf);
      out += s;
      // pip is chatty and its useful lines are the last ones; forward whole
      // lines so the UI can show live progress rather than a frozen spinner.
      for (const line of s.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim().slice(0, 200));
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e.message) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/**
 * The newest CPython these packages actually have wheels for.
 *
 * onnxruntime — which both openWakeWord and kokoro-onnx sit on — lags new
 * CPython releases by months, and pip's failure when a wheel is missing is
 * "Could not find a version that satisfies the requirement", which reads like a
 * network problem rather than "you are on too new a Python". Picking the
 * interpreter the wheels exist for is the difference between this working and
 * this producing a confusing error on a perfectly good machine.
 *
 * Raise this when onnxruntime ships for a newer version; the ordering below
 * degrades to "try it anyway" rather than refusing, so a too-low ceiling costs
 * a preference, not a capability.
 */
const MAX_WHEEL_MINOR = 13;
const MIN_MINOR = 9;

/** Version and pip availability for one interpreter, or null if unusable. */
async function inspect(exe) {
  const args = argsFor(exe);
  const r = await run(exe, [...args, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], { timeout: 20_000 });
  if (r.code !== 0) return null;
  const [maj, min] = String(r.out).trim().split(/\s+/).map(Number);
  if (maj !== 3 || !(min >= MIN_MINOR)) return null;
  const pip = await run(exe, [...args, "-m", "pip", "--version"], { timeout: 30_000 });
  if (pip.code !== 0) return null;
  // Inside a virtualenv `pip install --user` is a hard error ("User site-packages
  // are not visible in this virtualenv"), so the flag has to be conditional
  // rather than always-on. A venv is also already writable, which is the only
  // thing --user was buying.
  const venv = await run(exe, [...args, "-c", "import sys; print(int(sys.prefix != sys.base_prefix))"], { timeout: 20_000 });
  const inVenv = String(venv.out).trim().endsWith("1");
  // Does it ALREADY have either package? That interpreter is the one the app is
  // (or would be) running against, so topping it up beats installing a second
  // copy into a different Python and leaving the first one half-equipped.
  const has = await run(
    exe,
    [...args, "-c", "import importlib.util as u; print(int(any(u.find_spec(m) for m in ('openwakeword','kokoro_onnx','kokoro'))))"],
    { timeout: 25_000 },
  );
  return { exe, args, maj, min, version: `${maj}.${min}`, inVenv, hasPackages: String(has.out).trim().endsWith("1") };
}

/**
 * Which Python to install into. The packages are what we install, so unlike
 * findPythonWith() this must NOT require them to already be importable — but it
 * strongly prefers an interpreter that has them.
 *
 * Order: already-equipped first, then the newest interpreter within the wheel
 * ceiling, then anything usable at all.
 */
export async function findAnyPython() {
  const found = [];
  for (const exe of await candidates()) {
    const info = await inspect(exe);
    // `py` and a full path can be the same interpreter; keep the first seen.
    if (info && !found.some((f) => f.version === info.version)) found.push(info);
  }
  if (!found.length) {
    return {
      ok: false,
      reason:
        `No Python 3.${MIN_MINOR}+ with pip was found. Install Python from https://python.org/downloads ` +
        "(tick “Add python.exe to PATH”), then run this again. " +
        "If you have one in an unusual place, set GNOSIS_PYTHON to its full path.",
    };
  }
  const rank = (f) => [
    f.hasPackages ? 0 : 1,             // already equipped wins outright
    f.min <= MAX_WHEEL_MINOR ? 0 : 1,  // then: wheels are known to exist
    -f.min,                            // then: newest such version
  ];
  found.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  const pick = found[0];
  return {
    ok: true,
    ...pick,
    why: pick.hasPackages
      ? "already has the voice packages"
      : pick.min <= MAX_WHEEL_MINOR
        ? "newest version with onnxruntime wheels"
        : `no interpreter at or below 3.${MAX_WHEEL_MINOR} was found — trying anyway`,
  };
}

/** Download `url` to `dest`, reporting progress. Written to a .part file and
 * renamed on success, so an interrupted download never looks like a good one. */
async function download(url, dest, minBytes, onProgress) {
  const part = dest + ".part";
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url} returned ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let seen = 0;
  let lastPct = -1;
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    seen += c.length;
    const pct = total ? Math.floor((seen / total) * 100) : 0;
    // Report every 5% rather than every chunk: this is going to the UI over IPC.
    if (total && pct >= lastPct + 5) { lastPct = pct; onProgress?.(pct, seen, total); }
  });
  await pipeline(body, createWriteStream(part));
  const { size } = await fs.stat(part);
  if (size < minBytes) {
    await fs.rm(part, { force: true }).catch(() => {});
    // Almost always an HTML error/redirect page saved under the model's name.
    throw new Error(`downloaded ${path.basename(dest)} is only ${size} bytes — the download did not complete`);
  }
  await fs.rename(part, dest);
  return size;
}

/**
 * Install everything voice needs.
 *
 * @param onStep  called with { step, status, detail } as it goes
 * @param parts   which halves to do — { wakeword, kokoro }, both by default
 */
export async function installVoiceDeps({ onStep, parts = { wakeword: true, kokoro: true } } = {}) {
  const say = (step, status, detail) => onStep?.({ step, status, detail });
  const results = [];

  say("python", "running", "looking for a Python with pip…");
  const py = await findAnyPython();
  if (!py.ok) {
    say("python", "failed", py.reason);
    return { ok: false, reason: py.reason, results };
  }
  say("python", "done", `using Python ${py.version} (${py.exe}) — ${py.why}`);

  // --- pip packages ---------------------------------------------------------
  // onnxruntime is named explicitly: openWakeWord falls back to it from tflite
  // and kokoro-onnx requires it, and letting both pull it transitively is how
  // you end up with one of them silently on a version the other cannot use.
  const pkgs = [
    ...(parts.wakeword ? ["openwakeword"] : []),
    ...(parts.kokoro ? ["kokoro-onnx"] : []),
    "onnxruntime",
  ];
  if (pkgs.length > 1 || parts.wakeword || parts.kokoro) {
    say("pip", "running", `pip install ${pkgs.join(" ")}`);
    // --user avoids needing admin on a system-wide install, but is a hard error
    // inside a virtualenv — see inspect(). A venv is writable already.
    const flags = ["--upgrade", ...(py.inVenv ? [] : ["--user"])];
    const r = await run(py.exe, [...py.args, "-m", "pip", "install", ...flags, ...pkgs], {
      onLine: (l) => say("pip", "running", l),
    });
    if (r.code !== 0) {
      const reason = `pip install failed (exit ${r.code}). ${String(r.out).split(/\r?\n/).filter(Boolean).slice(-3).join(" ")}`;
      say("pip", "failed", reason);
      return { ok: false, reason, results };
    }
    say("pip", "done", `installed ${pkgs.join(", ")}`);
    results.push({ step: "pip", ok: true });
  }

  // --- openWakeWord models --------------------------------------------------
  if (parts.wakeword) {
    say("wake-models", "running", "downloading the wake-word models…");
    const r = await run(py.exe, [...py.args, "-c", "from openwakeword import utils; utils.download_models()"], {
      onLine: (l) => say("wake-models", "running", l),
    });
    if (r.code !== 0) {
      const reason = `wake-word model download failed (exit ${r.code}). ${String(r.out).split(/\r?\n/).filter(Boolean).slice(-2).join(" ")}`;
      say("wake-models", "failed", reason);
      results.push({ step: "wake-models", ok: false, reason });
    } else {
      say("wake-models", "done", "wake-word models ready");
      results.push({ step: "wake-models", ok: true });
    }
  }

  // --- Kokoro weights -------------------------------------------------------
  if (parts.kokoro) {
    await fs.mkdir(MODEL_DIR, { recursive: true }).catch(() => {});
    for (const f of KOKORO_FILES) {
      const dest = path.join(MODEL_DIR, f.name);
      // Already there and plausibly complete: skip. Re-downloading 310MB because
      // someone pressed the button twice is its own bug.
      const have = await fs.stat(dest).catch(() => null);
      if (have && have.size >= f.minBytes) {
        say("kokoro-weights", "done", `${f.name} already present`);
        results.push({ step: `kokoro:${f.name}`, ok: true, skipped: true });
        continue;
      }
      say("kokoro-weights", "running", `downloading ${f.name}…`);
      try {
        const size = await download(f.url, dest, f.minBytes, (pct) =>
          say("kokoro-weights", "running", `${f.name} ${pct}%`));
        say("kokoro-weights", "done", `${f.name} (${(size / 1e6).toFixed(0)} MB)`);
        results.push({ step: `kokoro:${f.name}`, ok: true });
      } catch (e) {
        const reason = `${f.name}: ${String(e?.message ?? e)}`;
        say("kokoro-weights", "failed", reason);
        results.push({ step: `kokoro:${f.name}`, ok: false, reason });
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    python: py.exe,
    results,
    reason: failed.length ? failed.map((f) => f.reason).filter(Boolean).join("; ") : undefined,
  };
}
