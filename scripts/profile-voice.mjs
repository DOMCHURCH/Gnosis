// Profile the voice pipeline stage by stage, against the real services.
//
//   node scripts/profile-voice.mjs
//
// Every stage is the real thing: real Python probe, real Groq Whisper call, real
// Kokoro synthesis. The model turn is excluded — it is the provider's latency,
// not ours, and it dominates or does not depending on which model is selected.
import { performance } from "node:perf_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const t = async (label, fn) => {
  const a = performance.now();
  let out, err;
  try { out = await fn(); } catch (e) { err = e; }
  const ms = performance.now() - a;
  console.log(`${String(Math.round(ms)).padStart(6)} ms  ${label}${err ? `  [FAILED: ${err.message}]` : ""}`);
  return { ms, out };
};

console.log("stage timings (real services, cold then warm)\n");

const { probeKokoro, synthesize } = await import("../electron/kokoro.js");
const { findPython, probeRuntime } = await import("../electron/wakeword.js");

// --- interpreter discovery ---------------------------------------------------
const wake1 = await t("wakeword: findPython (cold)", () => findPython());
const wake2 = await t("wakeword: findPython (again)", () => findPython());
const kok1 = await t("kokoro: probeKokoro (cold)", () => probeKokoro());
const kok2 = await t("kokoro: probeKokoro (again)", () => probeKokoro());

// --- synthesis ---------------------------------------------------------------
const syn1 = await t("kokoro: synthesize 8 words (cold)", () => synthesize("This is a short spoken reply for timing."));
const syn2 = await t("kokoro: synthesize 8 words (warm)", () => synthesize("This is a short spoken reply for timing."));

// --- transcription ------------------------------------------------------------
// A real Groq Whisper round trip on a real WAV, so the number is the network +
// model latency the user actually waits through.
let tr = { ms: 0 };
const wav = syn1.out?.ok ? syn1.out.path : null;
if (wav) {
  const { loadEnv } = await import("../dist/config.js");
  const env = await loadEnv();
  if (env.GROQ_API_KEY) {
    tr = await t("groq: transcribe that WAV", async () => {
      const bytes = await fs.readFile(wav);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "audio/wav" }), "speech.wav");
      form.append("model", "whisper-large-v3-turbo");
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` }, body: form,
      });
      if (!r.ok) throw new Error(`${r.status}`);
      return (await r.json()).text;
    });
  } else {
    console.log("     -- ms  groq: transcribe  [skipped: no GROQ_API_KEY]");
  }
}

console.log("\nranked, slowest first:");
const rows = [
  ["kokoro probe (runs INSIDE every synthesize)", kok1.ms],
  ["kokoro synthesis", Math.max(0, syn1.ms - kok1.ms)],
  ["wakeword interpreter discovery (once, at start)", wake1.ms],
  ["groq transcription", tr.ms],
];
for (const [name, ms] of rows.sort((a, b) => b[1] - a[1])) {
  console.log(`${String(Math.round(ms)).padStart(6)} ms  ${name}`);
}
console.log(`\nper-utterance cost of the probe alone: ~${Math.round(kok2.ms)} ms (it is not cached)`);
