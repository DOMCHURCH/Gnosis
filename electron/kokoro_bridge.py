"""Kokoro TTS bridge.

Kokoro is a small open-weights text-to-speech model that runs locally — no API
key, no network at synthesis time, and markedly more natural than Windows SAPI.

Two modes, both one-shot rather than a long-lived pipe. Synthesis is not a
stream the way wake-word detection is: a reply is spoken once, so a process per
utterance is simpler than a protocol and cannot wedge.

  --probe            report whether kokoro is usable and list its voices
  --speak <wav-out>  read UTF-8 text on stdin, write a WAV to <wav-out>
  --serve            stay alive; read one JSON request per line, synthesise each

--serve exists because loading the model costs ~2.8s and --speak paid it on every
single reply: a fresh interpreter, a fresh 325MB ONNX load, for eight words. The
served mode loads once and answers in the time synthesis actually takes. Requests
are {"text":..., "out":..., "voice":..., "speed":...}, one per line; each reply is
one JSON line. It is a pipe, not a protocol — the caller owns the ordering.

TWO BACKENDS, because "install Kokoro" resolves to two different packages and
picking one silently was what made this fall back to SAPI on a machine that had
Kokoro installed:

  kokoro         (hexgrad) — PyTorch. `from kokoro import KPipeline`. Downloads
                 its weights from HuggingFace on first use.
  kokoro_onnx    — onnxruntime. Needs kokoro-v1.0.onnx + voices-v1.0.bin on
                 disk; there is no auto-download, which is why a missing weight
                 file has to be reported as a path rather than as "not
                 installed".

Whichever is importable wins, torch first (better prosody), ONNX second. The
probe says which one answered so the settings panel can name it.

stdout is one JSON line in both modes; anything else goes to stderr.

Exit codes:
  0  fine
  2  no usable Kokoro (the caller falls back to SAPI)
  3  synthesis failed
"""

import json
import os
import sys

# The voices Kokoro ships. Listed here rather than discovered because the
# package exposes them inconsistently across versions, and the settings panel
# needs a stable list to populate its picker.
VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky",
    "am_adam", "am_michael",
    "bf_emma", "bf_isabella", "bm_george", "bm_lewis",
]

DEFAULT_VOICE = "af_heart"

# kokoro_onnx writes 24 kHz; so does the torch pipeline.
SAMPLE_RATE = 24000

MODEL_NAME = "kokoro-v1.0.onnx"
VOICES_NAME = "voices-v1.0.bin"


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _model_dir():
    """Where the ONNX weights live.

    GNOSIS_KOKORO_DIR first (the app sets it), then ~/.dom/kokoro, then the
    working directory — which is what the `kokoro-tts` CLI itself assumes, so a
    user who already downloaded the files for that command is not asked to do it
    twice.
    """
    for d in (os.environ.get("GNOSIS_KOKORO_DIR"),
              os.path.join(os.path.expanduser("~"), ".dom", "kokoro"),
              os.getcwd()):
        if d and os.path.exists(os.path.join(d, MODEL_NAME)) and os.path.exists(os.path.join(d, VOICES_NAME)):
            return d
    return None


def _load_torch():
    """The hexgrad `kokoro` package. Returns (speak_fn, error)."""
    try:
        from kokoro import KPipeline
    except Exception as e:  # noqa: BLE001
        return None, f"kokoro (torch) is not importable: {e}"
    try:
        # 'a' is the American-English voice pack; the voice id picks the speaker.
        pipe = KPipeline(lang_code="a")
    except Exception as e:  # noqa: BLE001
        return None, f"kokoro (torch) failed to start: {e}"

    def speak(text, voice, speed):
        import numpy as np
        # KPipeline yields per-sentence chunks; concatenating them gives one
        # utterance rather than a series of separate files to play in order.
        chunks = [audio for _, _, audio in pipe(text, voice=voice, speed=speed)]
        if not chunks:
            raise RuntimeError("kokoro produced no audio")
        return np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

    return speak, None


def _load_onnx():
    """kokoro_onnx + the two weight files. Returns (speak_fn, error)."""
    try:
        from kokoro_onnx import Kokoro
    except Exception as e:  # noqa: BLE001
        return None, f"kokoro_onnx is not importable: {e}"
    d = _model_dir()
    if not d:
        return None, (
            f"kokoro_onnx is installed but its weights are missing ({MODEL_NAME}, {VOICES_NAME}). "
            f"Put them in {os.path.join(os.path.expanduser('~'), '.dom', 'kokoro')} — they are at "
            "https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/"
        )
    try:
        k = Kokoro(os.path.join(d, MODEL_NAME), os.path.join(d, VOICES_NAME))
    except Exception as e:  # noqa: BLE001
        return None, f"kokoro_onnx failed to load its model: {e}"

    def speak(text, voice, speed):
        audio, _rate = k.create(text, voice=voice, speed=speed, lang="en-us")
        return audio

    return speak, None


def _load():
    """The first usable backend. Returns (speak_fn, backend_name, error)."""
    errors = []
    for name, loader in (("torch", _load_torch), ("onnx", _load_onnx)):
        fn, err = loader()
        if fn:
            return fn, name, None
        errors.append(err)
    return None, None, " / ".join(e for e in errors if e)


def probe() -> int:
    fn, backend, err = _load()
    if err:
        emit({"type": "probe", "installed": False, "python": sys.executable, "error": err, "voices": []})
        return 2
    del fn
    emit({
        "type": "probe",
        "installed": True,
        "python": sys.executable,
        "backend": backend,
        "voices": VOICES,
        "default": DEFAULT_VOICE,
    })
    return 0


def speak(out_path: str) -> int:
    text = sys.stdin.read().strip()
    if not text:
        emit({"type": "error", "message": "nothing to say"})
        return 3

    fn, backend, err = _load()
    if err:
        emit({"type": "error", "message": err, "installed": False})
        return 2

    voice = os.environ.get("GNOSIS_KOKORO_VOICE") or DEFAULT_VOICE
    speed = float(os.environ.get("GNOSIS_KOKORO_SPEED", "1.0"))
    try:
        import soundfile as sf

        audio = fn(text, voice, speed)
        sf.write(out_path, audio, SAMPLE_RATE)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "message": f"synthesis failed: {e}"})
        return 3

    emit({"type": "spoken", "path": out_path, "voice": voice, "backend": backend, "chars": len(text)})
    return 0


def serve() -> int:
    """Load the model once, then synthesise on demand until stdin closes."""
    fn, backend, err = _load()
    if err:
        emit({"type": "error", "message": err, "installed": False})
        return 2
    emit({"type": "ready", "backend": backend, "voices": VOICES, "default": DEFAULT_VOICE, "python": sys.executable})

    import soundfile as sf

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            emit({"type": "error", "message": f"bad request: {e}"})
            continue
        text = str(req.get("text") or "").strip()
        out_path = req.get("out")
        rid = req.get("id")
        if not text or not out_path:
            emit({"type": "error", "id": rid, "message": "need text and out"})
            continue
        voice = req.get("voice") or DEFAULT_VOICE
        try:
            speed = float(req.get("speed") or 1.0)
        except Exception:  # noqa: BLE001
            speed = 1.0
        try:
            audio = fn(text, voice, speed)
            sf.write(out_path, audio, SAMPLE_RATE)
        except Exception as e:  # noqa: BLE001
            # One bad request must not take the process down — the next reply
            # would then pay the model load all over again.
            emit({"type": "error", "id": rid, "message": f"synthesis failed: {e}"})
            continue
        emit({"type": "spoken", "id": rid, "path": out_path, "voice": voice, "backend": backend, "chars": len(text)})
    return 0


if __name__ == "__main__":
    try:
        if "--probe" in sys.argv:
            sys.exit(probe())
        if "--serve" in sys.argv:
            sys.exit(serve())
        if "--speak" in sys.argv:
            i = sys.argv.index("--speak")
            sys.exit(speak(sys.argv[i + 1]))
        emit({"type": "error", "message": "usage: kokoro_bridge.py --probe | --speak <wav-out> | --serve"})
        sys.exit(3)
    except KeyboardInterrupt:
        sys.exit(0)
    except BrokenPipeError:
        sys.exit(0)
