"""openWakeWord bridge.

Reads raw audio on stdin, writes one JSON object per line on stdout. Nothing
else goes to stdout — diagnostics go to stderr — so the Node side can parse the
stream a line at a time.

Audio format, fixed by openWakeWord: 16 kHz, mono, signed 16-bit little-endian.
The frames come from the Electron renderer's microphone (voice-engine.html),
which means this script needs no audio library at all — no PyAudio, no
sounddevice, no PortAudio to install. openwakeword + its own dependencies
(numpy, onnxruntime) are the whole requirement, which is what makes
"pip install openwakeword" enough.

Protocol
--------
stdout, one JSON object per line:
  {"type":"ready","models":[...]}          once, after models load
  {"type":"wake","model":"hey_jarvis","score":0.71}
  {"type":"error","message":"..."}
stdin:
  raw PCM bytes, any chunking; this script rebuffers to what the model wants.

Exit codes:
  0  clean end of stdin
  2  openwakeword is not installed (the message says how to fix it)
  3  models could not be loaded
"""

import json
import os
import sys


def emit(obj):
    """One JSON line, flushed — the reader is a pipe, not a terminal."""
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        import numpy as np
    except Exception as e:  # pragma: no cover - environment dependent
        emit({"type": "error", "message": f"numpy is missing ({e}). Run: pip install openwakeword"})
        return 2

    try:
        from openwakeword.model import Model
    except Exception as e:
        emit(
            {
                "type": "error",
                "message": (
                    "openwakeword is not installed in this Python "
                    f"({sys.executable}). Run: pip install openwakeword"
                ),
                "detail": str(e),
            }
        )
        return 2

    # openWakeWord ships its models on first use rather than in the wheel.
    # download_models() is a no-op once they are cached.
    try:
        import openwakeword

        if hasattr(openwakeword, "utils") and hasattr(openwakeword.utils, "download_models"):
            openwakeword.utils.download_models()
    except Exception as e:  # noqa: BLE001 - a download failure is not fatal if cached
        print(f"[gnosis] model download skipped: {e}", file=sys.stderr)

    wanted = [m for m in os.environ.get("GNOSIS_WAKE_MODELS", "").split(",") if m.strip()]
    threshold = float(os.environ.get("GNOSIS_WAKE_THRESHOLD", "0.5"))

    try:
        model = Model(wakeword_models=wanted) if wanted else Model()
    except Exception as e:
        emit({"type": "error", "message": f"could not load wake-word models: {e}"})
        return 3

    names = list(getattr(model, "models", {}) or {})
    emit({"type": "ready", "models": names, "threshold": threshold})

    # openWakeWord wants 1280 samples (80 ms at 16 kHz) per predict() call.
    FRAME = 1280
    BYTES = FRAME * 2
    buf = bytearray()

    # Fire once per utterance, not once per frame over the threshold: a spoken
    # wake phrase stays above it for several frames, and re-triggering on each
    # would open the overlay repeatedly for one "hey gnosis".
    armed = {}

    stream = sys.stdin.buffer
    while True:
        chunk = stream.read(BYTES)
        if not chunk:
            break
        buf.extend(chunk)
        while len(buf) >= BYTES:
            frame = bytes(buf[:BYTES])
            del buf[:BYTES]
            audio = np.frombuffer(frame, dtype=np.int16)
            try:
                scores = model.predict(audio)
            except Exception as e:  # noqa: BLE001
                emit({"type": "error", "message": f"predict failed: {e}"})
                return 3
            for name, score in (scores or {}).items():
                hot = score >= threshold
                if hot and not armed.get(name):
                    emit({"type": "wake", "model": name, "score": round(float(score), 4)})
                armed[name] = hot

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
    except BrokenPipeError:
        # The parent went away; that is a normal shutdown, not a crash.
        sys.exit(0)
