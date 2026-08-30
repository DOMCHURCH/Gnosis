// Kokoro text-to-speech, with Windows SAPI as the fallback.
//
// Kokoro is open-weights and runs locally: no key, no network at synthesis
// time, and far more natural than SAPI. It is a Python package, so it is wired
// exactly the way openWakeWord is — a child process, discovered rather than
// assumed, reporting what it needs when it is missing.
//
// The difference from the wake-word bridge is the shape: detection is a stream,
// synthesis is one-shot. A reply is spoken once, so this spawns per utterance
// and writes a WAV, rather than holding a pipe open that could wedge mid-sentence.
//
// Playback happens in Electron, not Python, so nothing here needs an audio
// output library — which is the same reasoning that keeps PyAudio out of the
// wake-word side.

import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { candidates, argsFor, asarPath } from "./python.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = asarPath(path.join(here, "kokoro_bridge.py"));

/** Where the ONNX weights live. The bridge looks here too; passing it explicitly
 * means a packaged app is not relying on the child's idea of the home directory. */
const MODEL_DIR = path.join(os.homedir(), ".dom", "kokoro");

/** The environment every bridge call needs. */
function bridgeEnv(extra = {}) {
  return { ...process.env, PYTHONUNBUFFERED: "1", GNOSIS_KOKORO_DIR: MODEL_DIR, ...extra };
}

/**
 * Which Python (if any) can synthesise, and what voices it offers.
 *
 * The interpreter list comes from python.js — the SAME probing the wake word
 * uses. It used to be a private copy of the older, broken version ("python",
 * "py", "python3"), which is why Kokoro reported itself uninstalled on a machine
 * where the wake word was running happily on the interpreter that had it: `py`
 * is the launcher default (3.14 here) and `python` is whatever venv is on PATH,
 * so neither was the 3.12 that `pip install` had actually written to.
 *
 * The last failure is kept and reported. "Not installed" and "installed but the
 * weights are missing" need different fixes, and collapsing them to one message
 * sends the user to reinstall a package that was never the problem.
 */
/** The probe result, kept. Measured at ~2.1s, and it was being paid inside EVERY
 * synthesize() — per spoken reply, for an answer that cannot change while the app
 * is running. Cleared by resetKokoro() so a user who installs Kokoro and then
 * enables voice is not told "no" forever. */
let probeCache = null;

export function resetKokoro() {
  probeCache = null;
  stopDaemon();
}

export async function probeKokoro() {
  if (probeCache) return probeCache;
  const r = await probeKokoroUncached();
  // Only a success is cached. A failure is usually something the user is in the
  // middle of fixing, and caching "not installed" would outlive the fix.
  if (r.ok) probeCache = r;
  return r;
}

async function probeKokoroUncached() {
  let lastError = null;
  for (const exe of await candidates()) {
    const info = await new Promise((resolve) => {
      execFile(exe, [...argsFor(exe), BRIDGE, "--probe"], { timeout: 60000, windowsHide: true, env: bridgeEnv() }, (_err, stdout) => {
        const line = String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop();
        try { resolve(line ? JSON.parse(line) : null); } catch { resolve(null); }
      });
    });
    if (info?.installed) {
      return { ok: true, exe, args: argsFor(exe), voices: info.voices ?? [], default: info.default ?? null, python: info.python, backend: info.backend ?? null };
    }
    if (info?.error) lastError = info.error;
  }
  return {
    ok: false,
    voices: [],
    reason: lastError ?? "Install Kokoro for a better voice: pip install kokoro-onnx (then put kokoro-v1.0.onnx and voices-v1.0.bin in ~/.dom/kokoro)",
  };
}

// --- the persistent synthesiser ---------------------------------------------
//
// Loading the model costs ~2.8s and the old one-shot mode paid it on every single
// reply: a fresh interpreter and a fresh 325MB ONNX load, to say eight words. So
// the process stays up and answers on a pipe. Started lazily on the first reply,
// not at launch — someone who never uses voice should not be running a Python
// process holding a third of a gigabyte.

let daemon = null;      // { child, ready, pending: Map }
let daemonSeq = 0;

function stopDaemon() {
  try { daemon?.child.kill(); } catch { /* already gone */ }
  daemon = null;
}

/** Start (or reuse) the synthesiser. Resolves once it reports ready. */
async function ensureDaemon() {
  if (daemon?.ready) return daemon;
  if (daemon?.starting) return daemon.starting;

  const py = await probeKokoro();
  if (!py.ok) return { error: py.reason };

  const pending = new Map();
  const child = spawn(py.exe, [...py.args, BRIDGE, "--serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: bridgeEnv(),
  });
  const d = { child, ready: false, pending, backend: null };
  daemon = d;

  let carry = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    // Line-delimited JSON, and a chunk boundary can land mid-line.
    carry += chunk;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg.type === "ready") { d.ready = true; d.backend = msg.backend ?? null; d.onReady?.(d); continue; }
      const p = msg.id != null ? pending.get(msg.id) : null;
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.type === "spoken") p.resolve({ ok: true, path: msg.path, voice: msg.voice, backend: msg.backend ?? d.backend });
      else p.resolve({ ok: false, reason: msg.message ?? "synthesis failed" });
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (t) => { stderr += t; });
  const die = (reason) => {
    for (const p of pending.values()) p.resolve({ ok: false, reason });
    pending.clear();
    if (daemon === d) daemon = null;
  };
  child.on("exit", (code) => die(`kokoro exited (${code})${stderr ? `: ${stderr.trim().split("\n").slice(-1)[0]}` : ""}`));
  child.on("error", (e) => die(e.message));

  d.starting = new Promise((resolve) => {
    // The model load is the long pole; anything past this is a broken install.
    const timer = setTimeout(() => resolve({ error: "kokoro did not become ready in 120s" }), 120000);
    d.onReady = (ready) => { clearTimeout(timer); resolve(ready); };
  });
  return d.starting;
}

/**
 * Synthesise `text` to a WAV file.
 * @returns { ok, path } or { ok:false, reason } — the caller falls back to SAPI.
 */
export async function synthesize(text, { voice, speed } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, reason: "nothing to say" };

  const d = await ensureDaemon();
  if (d?.error || !d?.child) return { ok: false, reason: d?.error ?? "kokoro unavailable", installed: false };

  const out = path.join(os.tmpdir(), `gnosis-tts-${crypto.randomBytes(6).toString("hex")}.wav`);
  const id = ++daemonSeq;
  const result = await new Promise((resolve) => {
    // Synthesis itself is fast once the model is up; this cap is for a wedged
    // pipe, not for slow speech.
    const timer = setTimeout(() => {
      d.pending.delete(id);
      resolve({ ok: false, reason: "kokoro timed out" });
    }, 60000);
    d.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); } });
    try {
      d.child.stdin.write(JSON.stringify({ id, text: t, out, voice, speed }) + "\n");
    } catch (e) {
      clearTimeout(timer);
      d.pending.delete(id);
      resolve({ ok: false, reason: e.message });
    }
  });
  if (!result.ok) await fs.rm(out, { force: true }).catch(() => {});
  return result;
}

/** Stop the synthesiser (app quit, or voice switched off). */
export function shutdownKokoro() {
  stopDaemon();
}
