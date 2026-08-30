// Voice mode. Desktop only, by construction: this lives in the main process and
// nothing here is reachable from the served page, so a browser tab or a phone on
// the LAN cannot start a microphone.
//
// Pipeline:
//   wake word ("hey jarvis")  ->  overlay appears, tray pulses
//   record until 1.5s silence ->  transcribe            ->  run as a turn
//   agent replies             ->  spoken via Kokoro (SAPI if it is missing)
//
// That last step is GATED. TTS fires for a turn the wake word armed and for no
// other: type into the chat and nothing is spoken, because the person typing is
// already reading. The gate is voicegate.js — separate so the rule can be tested
// without Electron, and verify/s84-voice-gating.mjs is that test.
//
// The wake word runs on openWakeWord — open source, local, and needing no
// account or API key. Only transcription needs a key (GROQ_API_KEY for Whisper);
// without it the overlay says so instead of pretending to hear. Status is
// reported through voiceStatus() so settings can name the missing piece rather
// than failing silently.

import { BrowserWindow, ipcMain, Notification, screen } from "electron";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startWakeWord, findPython, probeRuntime } from "./wakeword.js";
import { synthesize, probeKokoro, shutdownKokoro } from "./kokoro.js";
import { createReplyGate } from "./voicegate.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Words that mean "look at my screen" / "look through the camera". Matched on
 * the transcript so a spoken request can escalate to a vision turn. */
/**
 * The phrase the detector actually listens for.
 *
 * openWakeWord's pretrained set is alexa / hey_jarvis / hey_mycroft /
 * hey_rhasspy / timer / weather. There is NO "hey gnosis" model — that phrase
 * needs a custom model trained against it, which is future work. Until then the
 * app loads hey_jarvis and says so: telling someone to speak two words that
 * cannot possibly be detected is worse than naming two that can.
 *
 * GNOSIS_WAKE_MODELS overrides the model; this maps whichever is loaded back to
 * the English the user has to say.
 */
const PHRASES = {
  hey_jarvis: "hey jarvis",
  alexa: "alexa",
  hey_mycroft: "hey mycroft",
  hey_rhasspy: "hey rhasspy",
};
const DEFAULT_WAKE_MODEL = "hey_jarvis";

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

/** Speak text through Windows SAPI. The fallback, not the first choice.
 *
 * The text is passed as base64 and decoded inside PowerShell. Interpolating it
 * into the command string would be a command-injection hole the moment a model
 * reply contains a quote — and model replies are exactly what gets spoken. */
export function speakSapi(text) {
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

/**
 * Say something out loud.
 *
 * Kokoro when it is installed — local, no key, and far closer to a human voice
 * than SAPI. SAPI when it is not, because a robotic answer beats a silent one.
 * Which was used is returned, so the settings panel can say so rather than
 * leaving the user guessing why it sounds the way it does.
 */
export async function speak(text, { voice, play } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, error: "nothing to say" };
  const k = await synthesize(t, { voice });
  if (k.ok) {
    play?.(k.path);
    return { ok: true, engine: "kokoro", voice: k.voice, path: k.path };
  }
  const s = await speakSapi(t);
  return { ...s, engine: s.ok ? "sapi" : "none", fallbackReason: k.reason };
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
  let detector = null; // the openWakeWord child process
  let enabled = false;
  let status = { enabled: false, wakeWord: false, transcription: false, reason: "not started" };
  // Live diagnostics, surfaced in the settings panel. Every field answers a
  // question someone debugging "it isn't triggering" would otherwise have to
  // answer with a shell.
  let diag = {
    microphone: "disconnected",
    micReason: "voice is off",
    process: "not running",
    lastLevel: 0,
    frames: 0,
    bytes: 0,
    runtime: null,   // probeRuntime(): installed? models downloaded? which python?
    tts: null,       // which TTS engine will actually be used
    lastWake: null,
    // Which engine last spoke, and when. Empty until a voice turn has completed —
    // which is itself the answer to "does TTS fire on ordinary chat messages?".
    lastSpoke: null,
    lastSession: null,
    lastError: null,
  };

  /** The phrase to speak, derived from whichever model is loaded. */
  function wakePhrase() {
    const loaded = (status.models ?? [])[0] ?? DEFAULT_WAKE_MODEL;
    const key = String(loaded).replace(/_v\d.*$/, "");
    return PHRASES[key] ?? key.replace(/_/g, " ");
  }

  /**
   * Decode a WAV to 16 kHz mono 16-bit PCM — what the detector consumes.
   *
   * Kokoro writes 24 kHz and SAPI writes whatever it likes, so a resample is
   * unavoidable. Linear interpolation is enough here: this feeds a wake-word
   * classifier, not a listener.
   */
  async function wavTo16kMono(file) {
    const { promises: fsp } = await import("node:fs");
    const buf = await fsp.readFile(file);
    if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV file");
    // Walk the chunk list rather than assuming a 44-byte header: SAPI emits
    // extra chunks before `data` and a fixed offset reads them as samples.
    let pos = 12;
    let fmt = null;
    let data = null;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("ascii", pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      const body = buf.subarray(pos + 8, pos + 8 + size);
      if (id === "fmt ") fmt = { channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
      else if (id === "data") { data = body; break; }
      pos += 8 + size + (size % 2);
    }
    if (!fmt || !data) throw new Error("WAV has no fmt/data chunk");
    if (fmt.bits !== 16) throw new Error(`expected 16-bit audio, got ${fmt.bits}`);

    const inSamples = data.length / 2 / fmt.channels;
    const ratio = fmt.rate / 16000;
    const outSamples = Math.floor(inSamples / ratio);
    const out = Buffer.alloc(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const frac = src - i0;
      const at = (n) => {
        const idx = Math.min(n, inSamples - 1) * fmt.channels * 2;
        return data.readInt16LE(idx); // channel 0; a mono mixdown is not worth it here
      };
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(at(i0) * (1 - frac) + at(i0 + 1) * frac))), i * 2);
    }
    return out;
  }

  const overlayHtml = path.join(here, "voice-overlay.html");
  const enginePreload = path.join(here, "voice-preload.cjs");

  function makeOverlay() {
    if (overlay && !overlay.isDestroyed()) return overlay;
    // Centred along the bottom of the display the app is on, not glued to the app
    // window: this is a separate window with NO parent, so the main window stays
    // fully usable — you can keep typing in Gnosis while the panel is up, and
    // moving or minimising the main window does not drag the panel with it.
    const win = getWindow();
    const area = screen.getDisplayNearestPoint(
      win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()).bounds : screen.getPrimaryDisplay().bounds,
    ).workArea;
    const W = 500;
    const H = 200;
    overlay = new BrowserWindow({
      width: W,
      height: H,
      x: Math.round(area.x + (area.width - W) / 2),
      y: Math.round(area.y + area.height - H - 48),
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      // Focusable, unlike before: the panel now has a close button, and a
      // non-focusable window is a coin toss for reliable clicks on Windows. It is
      // shown with showInactive() so appearing still never steals focus — you
      // only give it focus by clicking it.
      focusable: true,
      hasShadow: false, // the CSS draws the shadow; two of them looks like a halo
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

  // --- the session ----------------------------------------------------------
  //
  // The wake word opens a SESSION, not a single question. It stays open across as
  // many turns as the user wants, and ends on exactly three things: the overlay's
  // ×, the spoken phrase "stop listening", or 60 seconds with nothing said.
  //
  // Anything else — a reply finishing, a turn producing nothing, a transcription
  // coming back empty — re-arms the recorder instead of closing. Making the user
  // say the wake word again between every sentence is what made it feel like a
  // command line with extra steps rather than a conversation.
  const IDLE_MS = 60000;
  let session = false;
  let idleTimer = null;

  /** Phrases that end it. Deliberately narrow: these fire on a transcript, and a
   * loose pattern would hang up mid-sentence on "...and then stop listening for
   * changes". Anchored, and only at the very start or the whole utterance. */
  const STOP_RE = /^\s*(stop listening|stop the session|end session|that'?s all|never ?mind|goodbye|nothing else)\b[.!]?\s*$/i;

  function armIdle() {
    clearTimeout(idleTimer);
    if (!session) return;
    idleTimer = setTimeout(() => endSession("60s of silence"), IDLE_MS);
  }

  /** Start listening again inside an open session, without a wake word. */
  function listenAgain(hint) {
    if (!session) return;
    toOverlay("voice:state", { state: "listening", transcript: "", response: "", hint: hint ?? undefined });
    armIdle();
    if (engine && !engine.isDestroyed()) engine.webContents.send("voice:record");
  }

  /** Wake: open the overlay and the session, then start recording. */
  function wake() {
    if (session) return; // already talking; a second detection is not a new session
    session = true;
    setListening(true);
    const o = makeOverlay();
    o.showInactive(); // visible, but focus stays wherever the user left it
    toOverlay("voice:state", {
      state: "listening",
      transcript: "",
      response: "",
      model: currentModel(),
      hint: "say “stop listening” or press × to end · 60s idle closes it",
    });
    if (Notification.isSupported()) {
      // The chime is the notification sound; the toast itself is deliberately
      // terse because the overlay is already on screen saying the same thing.
      new Notification({ title: "Gnosis", body: "Listening…", silent: false }).show();
    }
    armIdle();
    if (engine && !engine.isDestroyed()) engine.webContents.send("voice:record");
  }

  /** End the session for good. Idempotent — the ×, a stop phrase and the idle
   * timer can all arrive at once. */
  function endSession(why) {
    if (!session && !(overlay && !overlay.isDestroyed())) return;
    session = false;
    clearTimeout(idleTimer);
    // Closing means silence NOW — mid-word if that is where it is. A panel that
    // keeps talking after you close it is the most obviously broken thing a
    // voice feature can do.
    stopSpeaking();
    gate.disarm();
    setListening(false);
    if (overlay && !overlay.isDestroyed()) overlay.hide();
    diag.lastSession = `ended: ${why ?? "closed"}`;
  }

  /** Close the panel for THIS turn only — kept for the non-session paths. */
  function sleep() {
    if (session) { listenAgain(); return; }
    endSession("turn finished");
  }

  /** The active agent's model id, for the overlay's corner. */
  function currentModel() {
    try {
      return bridge?.getAgents?.()[0]?.model ?? "";
    } catch {
      return "";
    }
  }

  // The reply half of the pipeline: armed by the wake word, and by nothing else.
  // See voicegate.js for why that gate is a separate, testable module. Feeding it
  // the bus rather than a callback means the spoken answer is the SAME text the
  // chat rail shows — one source, so the two can never disagree.
  // --- speaking ---------------------------------------------------------------
  //
  // A queue, not a call, because three things all had to change at once:
  //
  //  * ECHO. speak() used to resolve as soon as playback was HANDED to the
  //    renderer, not when it finished — so the session re-armed the recorder
  //    while the reply was still coming out of the speakers, transcribed its own
  //    voice, and answered itself. Nothing here re-opens the microphone until the
  //    renderer reports the audio actually ended, plus a tail for the room.
  //  * LATENCY. Sentences arrive one at a time now (see the gate), so there has
  //    to be somewhere to line them up while the previous one plays.
  //  * STOPPING. Closing the overlay has to cut speech off mid-word, which means
  //    something must own the queue and the currently-playing clip.
  const MIC_REOPEN_MS = 500;

  const speech = { queue: [], busy: false, epoch: 0, onDrain: null };

  /** Tell the renderer to stop feeding the detector and refuse to record. */
  function micMuted(on) {
    if (engine && !engine.isDestroyed()) engine.webContents.send("voice:mute", { on });
  }

  /** Resolves when the renderer says the clip finished (or the wait times out —
   * a lost `ended` event must not wedge the session forever). */
  function playAndWait(file, epoch) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { speech.onDrain = null; resolve(); }, 60000);
      speech.onDrain = () => {
        if (epoch !== speech.epoch) return; // a stop happened; this clip is stale
        clearTimeout(timer);
        speech.onDrain = null;
        resolve();
      };
      play(file);
    });
  }

  /** Say everything queued, in order, then reopen the microphone. */
  async function drainSpeech() {
    if (speech.busy) return;
    speech.busy = true;
    const epoch = speech.epoch;
    micMuted(true);
    try {
      const { config } = await readEnv();
      while (speech.queue.length && epoch === speech.epoch) {
        const text = speech.queue.shift();
        const spoken = await speak(text, { voice: config.kokoroVoice });
        if (epoch !== speech.epoch) break; // stopped while synthesising
        diag.lastSpoke = `${spoken.engine ?? "none"} @ ${new Date().toISOString()}`;
        if (!spoken.ok) { diag.lastError = spoken.error ?? spoken.fallbackReason ?? "TTS failed"; continue; }
        if (spoken.path) await playAndWait(spoken.path, epoch);
      }
    } finally {
      speech.busy = false;
      if (epoch === speech.epoch) {
        // The tail: speakers and room reverb outlive the audio file, and reopening
        // the microphone on the same millisecond hears the end of our own sentence.
        setTimeout(() => {
          if (epoch !== speech.epoch) return;
          micMuted(false);
          if (session) { armIdle(); listenAgain(); }
          else sleep();
        }, MIC_REOPEN_MS);
      }
    }
  }

  function enqueueSpeech(text) {
    const t = String(text ?? "").trim();
    if (!t) return;
    speech.queue.push(t);
    void drainSpeech();
  }

  /** Cut speech off now: drop the queue, stop the clip, unmute. */
  function stopSpeaking() {
    speech.epoch++;          // invalidates every in-flight await above
    speech.queue.length = 0;
    speech.onDrain = null;
    speech.busy = false;
    if (engine && !engine.isDestroyed()) engine.webContents.send("voice:stop-audio");
    micMuted(false);
  }

  const gate = createReplyGate(
    // Whatever is left at the end of the turn (usually a tail with no full stop).
    (leftover) => {
      if (leftover) {
        toOverlay("voice:state", { state: "speaking", response: leftover });
        enqueueSpeech(leftover);
      } else if (!speech.busy && !speech.queue.length) {
        // The turn spoke and the queue already drained — nothing left to wait for.
        if (session) { armIdle(); listenAgain(); }
        else sleep();
      }
    },
    // A turn that produced no prose still keeps the session open.
    () => (session ? listenAgain() : sleep()),
    // Each finished sentence, spoken while the rest is still being written.
    (chunk) => {
      toOverlay("voice:state", { state: "speaking", response: chunk });
      enqueueSpeech(chunk);
    },
  );
  bridge?.bus?.subscribe((e) => gate.handle(e));

  /**
   * "switch to gemini" — the spoken form of /model.
   *
   * Handled here rather than being passed to the agent because it is an
   * instruction ABOUT the session, not a question for it: sent through as a
   * prompt, a model is quite likely to explain how to switch models instead of
   * switching. Resolution is resolveModelQuery — the exact function /model uses —
   * so "gemini" means the same thing spoken as typed.
   *
   * @returns true when it was a switch and has been dealt with.
   */
  // The filler words repeat and combine — "switch to the gemini model", "switch
  // model to deepseek" — so the lead-in is a repeating group rather than a list
  // of fixed alternatives, which left "the" glued to the model name.
  const SWITCH_RE = /^\s*(?:switch|change|use)\s+(?:(?:to|the|model|models)\s+)*(.+?)\s*(?:model)?\s*[.!]?\s*$/i;
  async function tryModelSwitch(text) {
    const m = text.match(SWITCH_RE);
    if (!m) return false;
    const query = (m[1] ?? "").trim();
    // Too short to be a model name, and far too easy to hit by accident.
    if (query.length < 3) return false;

    const tabId = bridge?.getAgents?.()[0]?.id ?? 0;
    const say = async (line) => {
      toOverlay("voice:state", { state: "speaking", response: line, model: currentModel() });
      // Through the queue, so the microphone stays muted until it has finished.
      enqueueSpeech(line);
    };

    try {
      const { fetchModels, resolveModelQuery } = await import("../dist/models.js");
      const all = await fetchModels();
      const hit = resolveModelQuery(all, query);
      // Not a model anybody has — treat it as an ordinary sentence rather than
      // swallowing it. "switch to the other branch" is a real request.
      if (hit.kind === "none") return false;
      const id = hit.kind === "exact" ? hit.id : hit.ids[0];
      bridge?.onCommand?.(tabId, `/model ${id}`);
      await say(`Switched to ${id.split("/").pop()}.`);
      return true;
    } catch {
      return false;
    }
  }

  /** A finished utterance: transcribe, run it, speak the reply. */
  async function handleUtterance(wavBase64) {
    const { env } = await readEnv();
    clearTimeout(idleTimer); // the user is talking; the idle clock restarts after
    toOverlay("voice:state", { state: "thinking", transcript: "", response: "" });

    const t = await transcribe(wavBase64, env.GROQ_API_KEY);
    if (!t.ok || !t.text) {
      // Not hearing one utterance is not a reason to hang up. Say so and listen
      // again; only the idle timer ends a session that has gone quiet.
      toOverlay("voice:state", { state: "error", transcript: t.error ?? "didn't catch that" });
      if (session) setTimeout(() => listenAgain(), 1200);
      else setTimeout(sleep, 3500);
      return;
    }

    toOverlay("voice:state", { state: "thinking", transcript: t.text, model: currentModel() });

    // "stop listening" ends it. Checked before anything else so it works even
    // while the agent would otherwise have something to say.
    if (STOP_RE.test(t.text)) {
      toOverlay("voice:state", { state: "speaking", transcript: t.text, response: "Stopping." });
      // Said, then closed: endSession() stops speech, so the confirmation has to
      // finish before it runs or it would cut off its own "okay".
      const { config } = await readEnv();
      const bye = await speak("Okay, stopping.", { voice: config.kokoroVoice });
      if (bye.ok && bye.path) await playAndWait(bye.path, speech.epoch);
      endSession("user said stop");
      return;
    }

    if (await tryModelSwitch(t.text)) return;

    // Vision escalation: a spoken question about the screen or the camera needs
    // an image attached, and a model that can read one. The engine borrows a
    // vision model for that turn if the session's own model cannot see.
    const wantsScreen = SCREEN_WORDS.test(t.text);
    const wantsCamera = CAMERA_WORDS.test(t.text);
    let prefix = "";
    if (wantsCamera) prefix = "[voice · camera] Call the camera tool, look at the frame, then answer: ";
    else if (wantsScreen) prefix = "[voice · screen] Call the screen tool, look at the capture, then answer: ";
    else prefix = "[voice] ";

    // Route through the same bridge the browser UI uses, so the exchange lands
    // in the chat rail like any other message.
    try {
      const agents = bridge?.getAgents?.() ?? [];
      const tabId = agents[0]?.id ?? 0;
      // Arm BEFORE handing the turn over: onInput runs the engine synchronously
      // far enough to emit its first lines, and arming afterwards would miss them.
      gate.arm(tabId);
      bridge?.onInput?.(tabId, prefix + t.text);
      // The overlay stays up until turn.end — the gate speaks the reply and
      // re-arms the recorder. A timer here would hide it mid-answer.
    } catch {
      /* no engine wired (boot failed) */
      gate.disarm();
      toOverlay("voice:state", { state: "error", response: "no agent is running" });
      setTimeout(sleep, 3500);
    }
  }

  // --- IPC from the engine/overlay renderers --------------------------------
  ipcMain.on("voice:wake", () => wake());
  // Raw PCM from the renderer's microphone, forwarded to openWakeWord. Arrives
  // continuously while voice is enabled, so it does nothing but hand bytes on.
  ipcMain.on("voice:audio", (_e, buf) => {
    if (detector && buf) {
      detector.write(Buffer.from(buf));
      const st = detector.stats?.();
      if (st) { diag.frames = st.frames; diag.bytes = st.bytes; diag.process = st.running ? "running" : "not running"; }
    }
  });
  // A cheap level meter so the panel can show that audio is genuinely moving,
  // not merely that a process exists.
  ipcMain.on("voice:level", (_e, level) => {
    diag.lastLevel = Number(level) || 0;
    // Straight through to the overlay's waveform. The overlay does not own the
    // microphone, so this forward is what makes the trace react to real speech
    // instead of animating a synthesised wave that ignored the room.
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.webContents.send("voice:level-out", diag.lastLevel);
  });
  ipcMain.on("voice:mic", (_e, s) => {
    diag.microphone = s?.ok ? "connected" : "disconnected";
    diag.micReason = s?.reason ?? "";
  });
  // The renderer reports when a clip actually finished playing. Waiting for THIS
  // rather than for speak() to resolve is what stops the microphone hearing the
  // tail of our own reply and answering it.
  ipcMain.on("voice:play-done", () => speech.onDrain?.());
  ipcMain.on("voice:utterance", (_e, wavBase64) => void handleUtterance(wavBase64));
  // The engine renderer heard nothing at all in a recording window. Inside a
  // session that is just a pause, not a hang-up.
  ipcMain.on("voice:cancel", () => {
    if (session) { armIdle(); listenAgain(); return; }
    gate.disarm();
    sleep();
  });
  // The overlay's × — the one unambiguous "stop".
  ipcMain.on("voice:end-session", () => endSession("closed from the overlay"));
  ipcMain.on("voice:engine-status", (_e, s) => {
    status = { ...status, ...s };
  });
  ipcMain.handle("voice:status", () => status);
  ipcMain.handle("voice:diagnostics", () => ({ ...diag, wakePhrase: wakePhrase() }));
  // The full probe is slow (it starts Python), so it is explicit rather than
  // part of every status read.
  ipcMain.handle("voice:probe-runtime", async () => {
    diag.runtime = await probeRuntime();
    const k = await probeKokoro();
    diag.tts = k.ok
      ? { engine: "kokoro", voices: k.voices, default: k.default, python: k.python }
      : { engine: "sapi", voices: [], reason: k.reason };
    return diag;
  });
  ipcMain.handle("voice:test", async () => testWakeWord());
  ipcMain.handle("voice:speak", async (_e, text) => {
    const { config } = await readEnv();
    return speak(text, { voice: config.kokoroVoice, play });
  });
  ipcMain.handle("voice:set-enabled", async (_e, on) => {
    if (on) await start();
    else stop();
    return status;
  });

  /** Play a WAV through the hidden engine renderer — main has no audio out. */
  function play(file) {
    const e = makeEngine();
    e.webContents.send("voice:play", file);
  }

  /**
   * Feed a synthesised wake phrase straight into the detector.
   *
   * Proves the Python side end to end without anyone having to speak, and
   * without the microphone — which is the point: it separates "the detector is
   * broken" from "the microphone is not reaching it".
   */
  async function testWakeWord() {
    if (!detector?.ok) {
      const runtime = await probeRuntime();
      return { ok: false, stage: "detector", reason: runtime.reason ?? "the detector is not running" };
    }
    // Say whichever phrase the loaded model actually listens for — see PHRASES.
    const phrase = wakePhrase();
    const { config } = await readEnv();
    const spoken = await speak(phrase, { voice: config.kokoroVoice });
    if (!spoken.ok || !spoken.path) {
      return { ok: false, stage: "tts", reason: spoken.error ?? spoken.fallbackReason ?? "could not synthesise the test phrase" };
    }
    let pcm;
    try {
      pcm = await wavTo16kMono(spoken.path);
    } catch (e) {
      return { ok: false, stage: "decode", reason: String(e?.message ?? e) };
    }
    const before = diag.lastWake;
    // 1280-sample frames, the size the model consumes.
    for (let off = 0; off + 2560 <= pcm.length; off += 2560) detector.write(pcm.subarray(off, off + 2560));
    await new Promise((r) => setTimeout(r, 2500));
    const fired = diag.lastWake && diag.lastWake !== before;
    return {
      ok: !!fired,
      stage: fired ? "done" : "detect",
      phrase,
      engine: spoken.engine,
      reason: fired ? `detected "${phrase}"` : `synthesised "${phrase}" and fed ${Math.round(pcm.length / 2560)} frames, but the detector did not fire`,
    };
  }

  async function start() {
    const { env } = await readEnv();
    enabled = true;

    // openWakeWord: no key, just the library. Report the install command if it
    // is missing rather than a bare "unavailable".
    detector?.stop();
    detector = await startWakeWord({
      // Just the one model. Loading all six costs a prediction per frame each
      // and lets "alexa" or "timer" open the overlay, which is not what anyone
      // asked for.
      models: [DEFAULT_WAKE_MODEL],
      onWake: (w) => {
        diag.lastWake = `${w?.model ?? "?"} @ ${new Date().toISOString()}`;
        wake();
      },
      onStatus: (s) => {
        diag.process = s.ready ? "running" : "not running";
        if (s.stderr) diag.lastError = s.stderr;
        status = {
          models: s.models ?? status.models,
          ...status,
          enabled: true,
          wakeWord: !!s.ready,
          transcription: !!env.GROQ_API_KEY,
          reason: s.ready
            ? env.GROQ_API_KEY
              ? `ready — listening for “${wakePhrase()}”`
              : "wake word ready, but no GROQ_API_KEY, so speech cannot be transcribed."
            : s.reason,
        };
      },
    });

    // Re-probe on start: the startup probe already ran, but a user who installed
    // Kokoro and then switched voice on expects the panel to notice.
    void probeKokoro().then((k) => {
      diag.tts = k.ok
        ? { engine: "kokoro", voices: k.voices, default: k.default, python: k.python, backend: k.backend }
        : { engine: "sapi", voices: [], reason: k.reason };
    });

    status = {
      enabled: true,
      wakeWord: !!detector.ok,
      transcription: !!env.GROQ_API_KEY,
      reason: detector.ok ? "starting the wake-word detector…" : detector.reason,
    };

    // The renderer owns the microphone; it streams PCM here for the detector.
    const e = makeEngine();
    e.webContents.once("did-finish-load", () => {
      e.webContents.send("voice:configure", { streamToDetector: detector.ok });
    });
    return status;
  }

  function stop() {
    enabled = false;
    endSession("voice switched off");
    // The synthesiser holds a Python process and the loaded model; voice off
    // means it goes too rather than idling on a third of a gigabyte.
    shutdownKokoro();
    gate.disarm(); // voice off must not leave a turn primed to talk

    detector?.stop();
    detector = null;
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

  // Probe the TTS engine once at startup, whether or not voice is on.
  //
  // This used to run only inside start(), so with voice disabled diag.tts stayed
  // null and the settings panel rendered its "Kokoro not installed" fallback —
  // reporting a result for a check that had never been made, on a machine where
  // Kokoro was installed and its weights were on disk. Telling someone to
  // reinstall a working package is worse than saying nothing. It costs one Python
  // process at launch, in the background, and nothing waits on it.
  void probeKokoro()
    .then((k) => {
      diag.tts = k.ok
        ? { engine: "kokoro", voices: k.voices, default: k.default, python: k.python, backend: k.backend }
        : { engine: "sapi", voices: [], reason: k.reason };
    })
    .catch((e) => {
      diag.tts = { engine: "sapi", voices: [], reason: `TTS probe failed: ${String(e?.message ?? e)}` };
    });

  // Exposed so settings can show whether the wake-word runtime is present
  // before the user turns voice on.
  ipcMain.handle("voice:probe", async () => findPython());

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
