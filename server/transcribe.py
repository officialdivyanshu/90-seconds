#!/usr/bin/env python3
"""
90SECONDS — transcription worker.

Takes a recording, returns JSON on stdout with the transcript and
word-level timestamps. The timestamps matter more than the text: pauses,
pace and hesitation are all computed from them downstream.

Usage:
    python transcribe.py <path-to-recording> [model]

Output shape:
    {
      "ok": true,
      "text": "full transcript",
      "durationSec": 87.4,
      "language": "en",
      "words": [{"w": "hello", "start": 0.42, "end": 0.71}, ...]
    }
"""

import json
import sys
import os

def fail(msg, code=1):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(code)


def main():
    if len(sys.argv) < 2:
        fail("usage: transcribe.py <file> [model]")

    path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("WHISPER_MODEL", "base.en")

    if not os.path.isfile(path):
        fail(f"file not found: {path}")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        fail("faster-whisper is not installed. Run: pip install faster-whisper")

    try:
        # int8 keeps CPU inference fast enough for 90-second clips.
        model = WhisperModel(model_size, device="cpu", compute_type="int8")

        segments, info = model.transcribe(
            path,
            word_timestamps=True,   # the whole point — pauses and pace need these
            vad_filter=True,        # skip silence, so leading dead air is not transcribed
            vad_parameters={"min_silence_duration_ms": 300},
        )

        words = []
        parts = []
        for seg in segments:
            parts.append(seg.text)
            for w in (seg.words or []):
                token = w.word.strip()
                if token:
                    words.append({
                        "w": token,
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                    })

        text = " ".join(p.strip() for p in parts).strip()

        print(json.dumps({
            "ok": True,
            "text": text,
            "durationSec": round(info.duration, 2),
            "language": info.language,
            "words": words,
        }))

    except Exception as e:
        fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
