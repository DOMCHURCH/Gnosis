"""Kokoro TTS bridge.

Kokoro is a small open-weights text-to-speech model that runs locally — no API
key, no network at synthesis time, and markedly more natural than Windows SAPI.

Two modes, both one-shot rather than a long-lived pipe. Synthesis is not a
stream the way wake-word detection is: a reply is spoken once, so a process per
utterance is simpler than a protocol and cannot wedge.

  --probe            report whether kokoro is importable and list its voices
  --speak <wav-out>  read UTF-8 text on stdin, write a WAV to <wav-out>

stdout is one JSON line in both modes; anything else goes to stderr.

Exit codes:
  0  fine
  2  kokoro is not installed (the caller falls back to SAPI)
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


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _load():
    """Import Kokoro. Returns (pipeline, error)."""
    try:
        from kokoro import KPipeline
    except Exception as e:  # noqa: BLE001
        return None, f"kokoro is not importable: {e}"
    try:
        # 'a' is the American-English voice pack; the voice id picks the speaker.
        return KPipeline(lang_code="a"), None
    except Exception as e:  # noqa: BLE001
        return None, f"kokoro failed to start: {e}"


def probe() -> int:
    pipe, err = _load()
    if err:
        emit({"type": "probe", "installed": False, "python": sys.executable, "error": err, "voices": []})
        return 2
    del pipe
    emit({"type": "probe", "installed": True, "python": sys.executable, "voices": VOICES, "default": DEFAULT_VOICE})
    return 0


def speak(out_path: str) -> int:
    text = sys.stdin.read().strip()
    if not text:
        emit({"type": "error", "message": "nothing to say"})
        return 3

    pipe, err = _load()
    if err:
        emit({"type": "error", "message": err, "installed": False})
        return 2

    voice = os.environ.get("GNOSIS_KOKORO_VOICE", DEFAULT_VOICE)
    speed = float(os.environ.get("GNOSIS_KOKORO_SPEED", "1.0"))
    try:
        import numpy as np
        import soundfile as sf

        # KPipeline yields per-sentence chunks; concatenating them gives one
        # utterance rather than a series of separate files to play in order.
        chunks = [audio for _, _, audio in pipe(text, voice=voice, speed=speed)]
        if not chunks:
            emit({"type": "error", "message": "kokoro produced no audio"})
            return 3
        audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        sf.write(out_path, audio, 24000)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "message": f"synthesis failed: {e}"})
        return 3

    emit({"type": "spoken", "path": out_path, "voice": voice, "chars": len(text)})
    return 0


if __name__ == "__main__":
    try:
        if "--probe" in sys.argv:
            sys.exit(probe())
        if "--speak" in sys.argv:
            i = sys.argv.index("--speak")
            sys.exit(speak(sys.argv[i + 1]))
        emit({"type": "error", "message": "usage: kokoro_bridge.py --probe | --speak <wav-out>"})
        sys.exit(3)
    except KeyboardInterrupt:
        sys.exit(0)
    except BrokenPipeError:
        sys.exit(0)
