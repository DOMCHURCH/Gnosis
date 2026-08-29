// Voice mode. Desktop only, by construction: this lives in the main process and
// nothing here is reachable from the served page, so a browser tab or a phone on
// the LAN cannot start a microphone.
//
// Pipeline:
//   wake word ("hey gnosis")  ->  overlay appears, tray pulses
//   record until 1.5s silence ->  transcribe            ->  run as a turn
//   agent replies             ->  spoken via Windows SAPI + shown in the chat
//
// TWO LEGS NEED KEYS AND ARE INERT WITHOUT THEM:
//   * wake word — Porcupine needs a Picovoice AccessKey (PICOVOICE_ACCESS_KEY).
//     Without it there is no always-listening trigger; the overlay can still be
//     opened deliberately (Ctrl+Shift+V, or the tray) and everything downstream
//     of it works.
//   * transcription — Groq Whisper needs GROQ_API_KEY. Without it the overlay
//     says so instead of pretending to hear.
// Both are reported through voiceStatus() so the settings window can tell the
// user exactly which piece is missing, rather than failing silently.

import { BrowserWindow, ipcMain, Notification } from "electron";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Words that mean "look at my screen" / "look through the camera". Matched on
 * the transcript so a spoken request can escalate to a vision turn. */
const SCREEN_WORDS = /\b(screen|screenshot|display|what am i looking at|explain this|on my monitor)\b/i;
const CAMERA_WORDS = /\b(camera|webcam|scan|look at me|what do you see)\b/i;

async function readEnv() {
  try {
    const { loadEnv, loadConfig } = await import("../dist/config.js");
    const [env, config] = await Promise.all([loadEnv(), loadConfig()]);
    return { env: env ?? {}, config: config ?? {} };
  } catch {
    return { env: {}, config: {} };
  }
}

/** Speak text through Windows SAPI.
 *
 * The text is passed as base64 and decoded inside PowerShell. Interpolating it
 * into the command string would be a command-injection hole the moment a model
 * reply contains a quote — and model replies are exactly what gets spoken. */
export function speak(text) {
  return new Promise((resolve) => {
    const t = String(text ?? "").trim();
    if (!t || process.platform !== "win32") return resolve({ ok: false, error: "SAPI is Windows-only." });
    // Keep it short: SAPI reads the whole string before returning, and nobody
    // wants a paragraph of synthesised speech.
    const clipped = t.length > 600 ? `${t.slice(0, 600)}…` : t;
    const b64 = Buffer.from(clipped, "utf8").toString("base64");
    const script = `
Add-Type -AssemblyName System.Speech
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Speak($t)
`;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 120000, windowsHide: true },
      (err) => resolve(err ? { ok: false, error: String(err.message).split("\n")[0] } : { ok: true }),
    );
  });
}

/** Transcribe WAV bytes with Groq Whisper. */
async function transcribe(wavBase64, apiKey) {
  if (!apiKey) return { ok: false, error: "No GROQ_API_KEY in ~/.dom/.env — cannot transcribe." };
  try {
    const bytes = Buffer.from(wavBase64, "base64");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/wav" }), "speech.wav");
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "json");
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!r.ok) return { ok: false, error: `Groq returned ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const j = await r.json();
    return { ok: true, text: String(j.text ?? "").trim() };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export function registerVoice({ getWindow, showWindow, setListening, bridge }) {
  let overlay = null;
  let engine = null; // the hidden always-listening renderer
  let enabled = false;
  let status = { enabled: false, wakeWord: false, transcription: false, reason: "not started" };

  const overlayHtml = path.join(here, "voice-overlay.html");
  const enginePreload = path.join(here, "voice-preload.cjs");

  function makeOverlay() {
    if (overlay && !overlay.isDestroyed()) return overlay;
    const win = getWindow();
    const b = win && !win.isDestroyed() ? win.getBounds() : null;
    const W = 300;
    const H = 120;
    overlay = new BrowserWindow({
      width: W,
      height: H,
      // Bottom-right of the app's own screen, clear of the taskbar.
      ...(b ? { x: Math.round(b.x + b.width - W - 28), y: Math.round(b.y + b.height - H - 28) } : {}),
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      focusable: false, // listening must not steal focus from what you are doing
      webPreferences: { preload: enginePreload, nodeIntegration: false, contextIsolation: true },
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    void overlay.loadFile(overlayHtml);
    overlay.on("closed", () => { overlay = null; });
    return overlay;
  }

  /** The hidden renderer that owns the microphone. Audio capture needs a DOM
   * (getUserMedia); the main process has none. */
  function makeEngine() {
    if (engine && !engine.isDestroyed()) return engine;
    engine = new BrowserWindow({
      show: false,
      webPreferences: { preload: enginePreload, nodeIntegration: false, contextIsolation: true },
    });
    void engine.loadFile(path.join(here, "voice-engine.html"));
    engine.on("closed", () => { engine = null; });
    return engine;
  }

  const toOverlay = (channel, payload) => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
  };

  /** Wake: show the overlay, pulse the tray, chime, and start recording. */
  function wake() {
    setListening(true);
    const o = makeOverlay();
    o.showInactive();
    toOverlay("voice:state", { state: "listening", text: "what do you need?" });
    if (Notification.isSupported()) {
      // The chime is the notification sound; the toast itself is deliberately
      // terse because the overlay is already on screen saying the same thing.
      new Notification({ title: "Gnosis", body: "Listening…", silent: false }).show();
    }
    if (engine && !engine.isDestroyed()) engine.webContents.send("voice:record");
  }

  function sleep() {
    setListening(false);
    if (overlay && !overlay.isDestroyed()) overlay.hide();
  }

  /** A finished utterance: transcribe, run it, speak the reply. */
  async function handleUtterance(wavBase64) {
    const { env } = await readEnv();
    toOverlay("voice:state", { state: "thinking", text: "…" });

    const t = await transcribe(wavBase64, env.GROQ_API_KEY);
    if (!t.ok || !t.text) {
      toOverlay("voice:state", { state: "error", text: t.error ?? "Heard nothing." });
      setTimeout(sleep, 3500);
      return;
    }

    toOverlay("voice:state", { state: "thinking", text: t.text });

    // Vision escalation: a spoken question about the screen or the camera needs
    // an image attached, and a model that can read one.
    const wantsScreen = SCREEN_WORDS.test(t.text);
    const wantsCamera = CAMERA_WORDS.test(t.text);
    let prefix = "";
    if (wantsScreen) prefix = "[voice · screen] Take a screenshot with the computer tool, then answer: ";
    else if (wantsCamera) prefix = "[voice · camera] Capture a webcam frame, then answer: ";
    else prefix = "[voice] ";

    // Route through the same bridge the browser UI uses, so the exchange lands
    // in the chat rail like any other message.
    try {
      const agents = bridge?.getAgents?.() ?? [];
      const tabId = agents[0]?.id ?? 0;
      bridge?.onInput?.(tabId, prefix + t.text);
    } catch {
      /* no engine wired (boot failed) */
    }

    toOverlay("voice:state", { state: "speaking", text: t.text });
    setTimeout(sleep, 2500);
  }

  // --- IPC from the engine/overlay renderers --------------------------------
  ipcMain.on("voice:wake", () => wake());
  ipcMain.on("voice:utterance", (_e, wavBase64) => void handleUtterance(wavBase64));
  ipcMain.on("voice:cancel", () => sleep());
  ipcMain.on("voice:engine-status", (_e, s) => {
    status = { ...status, ...s };
  });
  ipcMain.handle("voice:status", () => status);
  ipcMain.handle("voice:speak", (_e, text) => speak(text));
  ipcMain.handle("voice:set-enabled", async (_e, on) => {
    if (on) await start();
    else stop();
    return status;
  });

  async function start() {
    const { env, config } = await readEnv();
    enabled = true;
    const wakeKey = env.PICOVOICE_ACCESS_KEY ?? config.picovoiceAccessKey ?? null;
    status = {
      enabled: true,
      wakeWord: !!wakeKey,
      transcription: !!env.GROQ_API_KEY,
      reason: !wakeKey
        ? "No PICOVOICE_ACCESS_KEY — the wake phrase is off; open voice with Ctrl+Shift+V."
        : !env.GROQ_API_KEY
          ? "No GROQ_API_KEY — speech cannot be transcribed."
          : "ready",
    };
    const e = makeEngine();
    e.webContents.once("did-finish-load", () => {
      e.webContents.send("voice:configure", { accessKey: wakeKey, keyword: "hey gnosis" });
    });
    return status;
  }

  function stop() {
    enabled = false;
    setListening(false);
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    if (engine && !engine.isDestroyed()) engine.destroy();
    overlay = null;
    engine = null;
    status = { enabled: false, wakeWord: false, transcription: false, reason: "disabled" };
  }

  // Enabled only when the user has turned it on: a coding tool has no business
  // opening a microphone on first launch.
  void (async () => {
    const { config } = await readEnv();
    if (config.voiceEnabled) await start();
    else status = { enabled: false, wakeWord: false, transcription: false, reason: "disabled in settings" };
  })();

  return {
    start,
    stop,
    /** Manual trigger — the path that works without a Picovoice key. */
    trigger: () => {
      if (!enabled) void start();
      showWindow?.();
      wake();
    },
    status: () => status,
  };
}
