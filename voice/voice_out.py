#!/usr/bin/env python3
"""Voice Jarvis Phase 1 — voice-out daemon.

Tails Jarvis's Telegram outbox (state/telegram-outbox.jsonl) and speaks each new
reply aloud via Piper → afplay. One brain, two faces: this adds a voice on top of
the existing Telegram replies — it does NOT change how Jarvis works.

- Source: orgs/main/agents/jarvis/state/telegram-outbox.jsonl ({ts,to,text} per line)
- TTS: Piper (PyPI/pipx ARM64 wheel) en_US-ryan-high, length_scale=0.85
- Playback: afplay (serial queue — replies never overlap)
- Starts at end-of-file (only speaks NEW replies, not history)

Run: python3 voice/voice_out.py    (Ctrl-C to stop)
Env overrides: VOICE_OUTBOX, VOICE_PIPER, VOICE_MODEL, VOICE_LENGTH_SCALE.
"""
from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

HOME = Path.home()
DEFAULT_OUTBOX = HOME / "cortextos/orgs/main/agents/jarvis/state/voice-outbound.jsonl"
DEFAULT_PIPER = HOME / ".local/bin/piper"
DEFAULT_MODEL = HOME / "cortextos/en_US-ryan-high.onnx"
VOICE_CONFIG = HOME / "cortextos/orgs/main/agents/jarvis/state/voice-config.json"
MODELS_DIR = HOME / "cortextos"

OUTBOX = Path(os.getenv("VOICE_OUTBOX", str(DEFAULT_OUTBOX)))
PIPER = Path(os.getenv("VOICE_PIPER", str(DEFAULT_PIPER)))
MODEL = Path(os.getenv("VOICE_MODEL", str(DEFAULT_MODEL)))
LENGTH_SCALE = os.getenv("VOICE_LENGTH_SCALE", "0.85")


def get_voice_config() -> tuple[Path, str]:
    """Read voice-config.json for active model + speed, fall back to defaults.

    Config stores 'speed' as a user-facing multiplier (0.5=slow, 1.0=normal, 2.0=fast).
    Piper's length_scale is the inverse: length_scale = 1.0 / speed.
    """
    model = MODEL
    length_scale = LENGTH_SCALE
    try:
        data = json.loads(VOICE_CONFIG.read_text())
        voice_id = data.get("voice", "")
        if voice_id:
            candidate = MODELS_DIR / f"{voice_id}.onnx"
            if candidate.exists():
                model = candidate
        cfg_speed = data.get("speed")
        if cfg_speed is not None:
            spd = max(0.5, min(2.0, float(cfg_speed)))
            length_scale = str(round(1.0 / spd, 3))
    except (OSError, json.JSONDecodeError, KeyError, ValueError):
        pass
    return model, length_scale
POLL_INTERVAL = 0.5
MAX_SPEAK_CHARS = 600          # don't read essays aloud; speak the gist

# Strip Telegram/markdown noise + URLs so speech is clean
_URL_RE = re.compile(r"https?://\S+")
_MD_RE = re.compile(r"[*_`#>\[\]]")
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF]",
    flags=re.UNICODE,
)


def clean_for_speech(text: str) -> str:
    t = _URL_RE.sub("", text)
    t = _EMOJI_RE.sub("", t)
    t = _MD_RE.sub("", t)
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) > MAX_SPEAK_CHARS:
        t = t[:MAX_SPEAK_CHARS].rsplit(".", 1)[0] + "."
    return t


def synth_and_play(text: str) -> None:
    """Piper → wav → afplay. Blocking (caller serializes via the queue)."""
    clean = clean_for_speech(text)
    if not clean:
        return
    active_model, active_speed = get_voice_config()
    wav = Path(f"/tmp/jarvis_voice_{os.getpid()}_{int(time.time()*1000)}.wav")
    try:
        proc = subprocess.run(
            [str(PIPER), "-m", str(active_model), "--length_scale", active_speed, "-f", str(wav)],
            input=clean.encode(), capture_output=True, timeout=60,
        )
        if proc.returncode != 0 or not wav.exists():
            sys.stderr.write(f"voice_out: piper failed: {proc.stderr.decode()[:200]}\n")
            return
        subprocess.run(["afplay", str(wav)], timeout=120)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"voice_out: synth/play error: {exc}\n")
    finally:
        try:
            wav.unlink(missing_ok=True)
        except Exception:
            pass


def speaker_loop(q: "queue.Queue[str]") -> None:
    """Serial speaker — one reply at a time, FIFO."""
    while True:
        text = q.get()
        if text is None:
            return
        synth_and_play(text)
        q.task_done()


def tail_outbox(q: "queue.Queue[str]") -> None:
    """Poll the outbox for new messages by tracking the last-seen timestamp.

    The outbox file is periodically rewritten by a 200-line rolling cap
    (writeFileSync), which breaks readline-based tailing.  Instead, we poll
    the last few lines and speak any with timestamps newer than the last one
    we processed.
    """
    while not OUTBOX.exists():
        time.sleep(POLL_INTERVAL)

    # Start with the current last timestamp so we don't replay history
    last_seen_ts: str | None = None
    try:
        lines = OUTBOX.read_text().split("\n")
        lines = [l for l in lines if l.strip()]
        if lines:
            entry = json.loads(lines[-1])
            last_seen_ts = entry.get("ts")
    except Exception:
        pass

    sys.stderr.write(f"voice_out: polling from ts={last_seen_ts}\n")
    sys.stderr.flush()

    while True:
        time.sleep(POLL_INTERVAL)
        try:
            content = OUTBOX.read_text()
        except OSError:
            continue
        lines = content.split("\n")
        lines = [l for l in lines if l.strip()]
        if not lines:
            continue

        new_messages: list[tuple[str, str]] = []
        for line in lines:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = entry.get("ts", "")
            text = entry.get("tldr") or entry.get("text", "")
            if not ts or not text:
                continue
            if last_seen_ts is None or ts > last_seen_ts:
                new_messages.append((ts, text))

        for ts, text in new_messages:
            last_seen_ts = ts
            q.put(text)


def main() -> None:
    if not PIPER.exists():
        sys.exit(f"voice_out: piper not found at {PIPER}")
    if not MODEL.exists():
        sys.exit(f"voice_out: model not found at {MODEL}")
    print(f"voice_out: watching {OUTBOX}\n  piper={PIPER}\n  model={MODEL} (length_scale={LENGTH_SCALE})")
    q: "queue.Queue[str]" = queue.Queue()
    threading.Thread(target=speaker_loop, args=(q,), daemon=True).start()
    try:
        tail_outbox(q)
    except KeyboardInterrupt:
        print("\nvoice_out: stopped")


if __name__ == "__main__":
    main()
