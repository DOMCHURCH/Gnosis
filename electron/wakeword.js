// Wake-word detection via openWakeWord.
//
// openWakeWord is open source and needs no account, no API key and no network
// at detection time — the models run locally. That is the whole reason it
// replaced Porcupine here: Porcupine's free tier still required a Picovoice
// AccessKey, which meant the feature could not work out of the box.
//
// It is a Python library with no npm equivalent (there is no `openwakeword`
// package on the registry), so it runs as a child process. The audio does NOT
// come from Python: the Electron renderer already holds the microphone, and it
// streams 16 kHz mono PCM down this pipe. That keeps PyAudio/PortAudio — by far
// the most fragile part of a Python audio install — out of the picture
// entirely, leaving `pip install openwakeword` as the only requirement.

import { spawn, execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, "openwakeword_bridge.py");

/** Interpreters to try, in order. GNOSIS_PYTHON wins if it is set. */
function candidates() {
  const explicit = process.env.GNOSIS_PYTHON;
  const list = explicit ? [explicit] : [];
  // `py -3` is the Windows launcher and is usually the most reliable; plain
  // `python` on Windows can be the App Execution Alias stub that opens the
  // Store instead of running anything.
  return [...list, "python", "py", "python3"];
}

/** Ask an interpreter whether it can import openwakeword. */
function probe(exe) {
  return new Promise((resolve) => {
    const args = exe === "py" ? ["-3", "-c", "import openwakeword;print('ok')"] : ["-c", "import openwakeword;print('ok')"];
    execFile(exe, args, { timeout: 20000, windowsHide: true }, (err, stdout) => {
      resolve(String(stdout ?? "").includes("ok") ? { ok: true, exe, args: exe === "py" ? ["-3"] : [] } : { ok: false, exe, error: err?.message });
    });
  });
}

/**
 * Find a Python that has openwakeword.
 * Returns { ok, exe, args } or { ok:false, reason } with an actionable message.
 */
export async function findPython() {
  const tried = [];
  for (const exe of candidates()) {
    const r = await probe(exe);
    if (r.ok) return r;
    tried.push(exe);
  }
  return {
    ok: false,
    reason:
      "openWakeWord is not installed. It is free and needs no API key — install it with:  pip install openwakeword" +
      `  (tried: ${tried.join(", ")}; set GNOSIS_PYTHON to point at a specific interpreter)`,
  };
}

/**
 * Start the detector.
 *
 * @param onWake    called with { model, score } per detected utterance
 * @param onStatus  called with { ready, models?, reason }
 * @returns { write(pcm), stop() } — write() takes Int16 PCM at 16 kHz mono
 */
export async function startWakeWord({ onWake, onStatus, models = [], threshold = 0.5 }) {
  const py = await findPython();
  if (!py.ok) {
    onStatus?.({ ready: false, reason: py.reason });
    return { write() {}, stop() {}, ok: false, reason: py.reason };
  }

  const child = spawn(py.exe, [...py.args, BRIDGE], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      GNOSIS_WAKE_MODELS: models.join(","),
      GNOSIS_WAKE_THRESHOLD: String(threshold),
      // Unbuffered, or a line can sit in Python's stdout buffer well past the
      // moment the user said the word.
      PYTHONUNBUFFERED: "1",
    },
  });

  let stopped = false;
  let carry = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    // The stream is line-delimited JSON, but a chunk boundary can land mid-line.
    carry += chunk;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try {
        msg = JSON.parse(t);
      } catch {
        continue; // stray output is not fatal
      }
      if (msg.type === "wake") onWake?.({ model: msg.model, score: msg.score });
      else if (msg.type === "ready") onStatus?.({ ready: true, models: msg.models, reason: "listening for the wake phrase" });
      else if (msg.type === "error") onStatus?.({ ready: false, reason: msg.message });
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s) console.error("[wakeword]", s.split("\n")[0]);
  });

  child.on("exit", (code) => {
    if (stopped) return;
    onStatus?.({
      ready: false,
      reason: code === 2 ? "openWakeWord is not installed — run: pip install openwakeword" : `wake-word process exited (${code})`,
    });
  });

  child.on("error", (e) => onStatus?.({ ready: false, reason: `could not start Python: ${e.message}` }));

  return {
    ok: true,
    /** @param {Buffer} pcm 16-bit little-endian mono @16kHz */
    write(pcm) {
      if (stopped || !child.stdin.writable) return;
      // Never let a slow detector build an unbounded backlog of audio: dropping
      // frames costs a missed wake word, buffering them costs the whole app.
      if (child.stdin.writableLength > 1_000_000) return;
      child.stdin.write(pcm);
    },
    stop() {
      stopped = true;
      try { child.stdin.end(); } catch { /* already gone */ }
      try { child.kill(); } catch { /* already gone */ }
    },
  };
}
