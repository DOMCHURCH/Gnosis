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

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, "kokoro_bridge.py");

function candidates() {
  const explicit = process.env.GNOSIS_PYTHON;
  return [...(explicit ? [explicit] : []), "python", "py", "python3"];
}

function argsFor(exe) {
  return exe === "py" ? ["-3"] : [];
}

/** Which Python (if any) can import kokoro, and what voices it offers. */
export async function probeKokoro() {
  for (const exe of candidates()) {
    const info = await new Promise((resolve) => {
      execFile(exe, [...argsFor(exe), BRIDGE, "--probe"], { timeout: 60000, windowsHide: true }, (_err, stdout) => {
        const line = String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop();
        try { resolve(line ? JSON.parse(line) : null); } catch { resolve(null); }
      });
    });
    if (info?.installed) return { ok: true, exe, args: argsFor(exe), voices: info.voices ?? [], default: info.default ?? null, python: info.python };
  }
  return {
    ok: false,
    voices: [],
    reason: "Install Kokoro for better voice: pip install kokoro-tts",
  };
}

/**
 * Synthesise `text` to a WAV file.
 * @returns { ok, path } or { ok:false, reason } — the caller falls back to SAPI.
 */
export async function synthesize(text, { voice, speed } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, reason: "nothing to say" };

  const py = await probeKokoro();
  if (!py.ok) return { ok: false, reason: py.reason, installed: false };

  const out = path.join(os.tmpdir(), `gnosis-tts-${crypto.randomBytes(6).toString("hex")}.wav`);
  const result = await new Promise((resolve) => {
    const child = spawn(py.exe, [...py.args, BRIDGE, "--speak", out], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        ...(voice ? { GNOSIS_KOKORO_VOICE: voice } : {}),
        ...(speed ? { GNOSIS_KOKORO_SPEED: String(speed) } : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // Kokoro loads a model on first use; that can genuinely take a while.
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      let msg = null;
      try { msg = line ? JSON.parse(line) : null; } catch { /* not JSON */ }
      if (code === 0 && msg?.type === "spoken") resolve({ ok: true, path: out, voice: msg.voice });
      else resolve({ ok: false, reason: msg?.message ?? stderr.trim().split("\n").slice(-1)[0] ?? `kokoro exited ${code}` });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
    child.stdin.end(t, "utf8");
  });
  if (!result.ok) await fs.rm(out, { force: true }).catch(() => {});
  return result;
}
