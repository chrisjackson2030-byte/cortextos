#!/usr/bin/env python3
"""Voice Jarvis — voice-in daemon.

Listens on the microphone for "Hey Jarvis" wake word, records speech until
silence, transcribes with whisper, and feeds the text into Jarvis via the
cortextos bus (Telegram self-message or voice-inbound.jsonl).

Components:
  - openwakeword: wake word detection (hey_jarvis_v0.1 model)
  - sounddevice: mic capture (PortAudio)
  - whisper.cpp: local STT transcription
  - cortextos bus: sends transcribed text to Jarvis

Run: python3 voice/voice_in.py    (Ctrl-C to stop)
Env: VOICE_WHISPER_MODEL (default: base), VOICE_SILENCE_SECONDS (default: 1.5)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280  # 80ms at 16kHz — openwakeword expects this size
SILENCE_THRESHOLD = 0.01
SILENCE_SECONDS = float(os.getenv("VOICE_SILENCE_SECONDS", "1.5"))
MAX_RECORD_SECONDS = 30
WHISPER_MODEL = os.getenv("VOICE_WHISPER_MODEL", "base")

HOME = Path.home()
WHISPER_BIN = Path(os.getenv("VOICE_WHISPER_BIN", "/opt/homebrew/bin/whisper"))
INBOUND_JSONL = HOME / "cortextos/orgs/main/agents/jarvis/state/voice-inbound.jsonl"
OUTBOUND_JSONL = HOME / "cortextos/orgs/main/agents/jarvis/state/voice-outbound.jsonl"
CORTEXTOS_BIN = "cortextos"

TELEGRAM_CHAT_ID = os.getenv("CTX_TELEGRAM_CHAT_ID", "")


def load_wakeword_model():
    from openwakeword.model import Model
    return Model(
        wakeword_models=["hey_jarvis_v0.1"],
        inference_framework="onnx",
    )


def is_silence(audio_chunk: np.ndarray) -> bool:
    return np.abs(audio_chunk).mean() < SILENCE_THRESHOLD


def record_utterance() -> np.ndarray | None:
    """Record from mic until silence, return audio as float32 array."""
    frames: list[np.ndarray] = []
    silence_chunks = 0
    silence_limit = int(SILENCE_SECONDS / (CHUNK_SAMPLES / SAMPLE_RATE))
    max_chunks = int(MAX_RECORD_SECONDS / (CHUNK_SAMPLES / SAMPLE_RATE))

    sys.stderr.write("voice_in: listening...\n")
    sys.stderr.flush()

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                        blocksize=CHUNK_SAMPLES) as stream:
        for _ in range(max_chunks):
            data, _ = stream.read(CHUNK_SAMPLES)
            chunk = data[:, 0]
            frames.append(chunk)
            if is_silence(chunk):
                silence_chunks += 1
                if silence_chunks >= silence_limit:
                    break
            else:
                silence_chunks = 0

    if not frames:
        return None
    audio = np.concatenate(frames)
    if np.abs(audio).mean() < SILENCE_THRESHOLD * 0.5:
        return None
    return audio


def transcribe(audio: np.ndarray) -> str:
    """Run whisper on the recorded audio, return transcript text."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
    try:
        sf.write(wav_path, audio, SAMPLE_RATE)
        result = subprocess.run(
            [str(WHISPER_BIN), wav_path, "--model", WHISPER_MODEL,
             "--language", "en", "--output_format", "txt"],
            capture_output=True, text=True, timeout=60,
        )
        txt_path = wav_path.replace(".wav", ".txt")
        if os.path.exists(txt_path):
            text = open(txt_path).read().strip()
            os.unlink(txt_path)
            return text
        return result.stdout.strip()
    except Exception as exc:
        sys.stderr.write(f"voice_in: transcription error: {exc}\n")
        return ""
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


def log_inbound(text: str) -> None:
    """Write to voice-inbound.jsonl for dashboard/audit."""
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "source": "mic",
        "text": text,
    }
    with open(INBOUND_JSONL, "a") as f:
        f.write(json.dumps(entry) + "\n")


def send_to_jarvis(text: str) -> str | None:
    """Send transcribed text to Jarvis via claude --print, return response."""
    try:
        result = subprocess.run(
            ["claude", "--print", "--model", "haiku", "-p", text],
            capture_output=True, text=True, timeout=30,
            env={**os.environ, "PATH": f"{HOME}/.local/bin:/opt/homebrew/bin:{os.environ.get('PATH', '')}"},
        )
        return result.stdout.strip() if result.returncode == 0 else None
    except Exception as exc:
        sys.stderr.write(f"voice_in: claude error: {exc}\n")
        return None


def queue_speech(text: str) -> None:
    """Write to voice-outbound.jsonl so voice_out.py speaks it."""
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "text": text,
    }
    with open(OUTBOUND_JSONL, "a") as f:
        f.write(json.dumps(entry) + "\n")


def play_chime(chime: str = "begin") -> None:
    """Play a system sound to indicate wake word detected / done."""
    sounds = {
        "begin": "/System/Library/Sounds/Tink.aiff",
        "end": "/System/Library/Sounds/Pop.aiff",
    }
    path = sounds.get(chime)
    if path and os.path.exists(path):
        subprocess.Popen(["afplay", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> None:
    if not WHISPER_BIN.exists():
        sys.exit(f"voice_in: whisper not found at {WHISPER_BIN}")

    sys.stderr.write("voice_in: loading wake word model...\n")
    sys.stderr.flush()
    oww = load_wakeword_model()

    sys.stderr.write("voice_in: ready — say 'Hey Jarvis' to begin\n")
    sys.stderr.flush()

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                        blocksize=CHUNK_SAMPLES) as stream:
        while True:
            data, _ = stream.read(CHUNK_SAMPLES)
            audio_int16 = data[:, 0]

            prediction = oww.predict(audio_int16)
            score = prediction.get("hey_jarvis_v0.1", 0)

            if score > 0.5:
                play_chime("begin")
                sys.stderr.write(f"voice_in: wake word detected (score={score:.2f})\n")
                sys.stderr.flush()
                oww.reset()

                audio = record_utterance()
                if audio is None:
                    sys.stderr.write("voice_in: no speech detected\n")
                    play_chime("end")
                    continue

                text = transcribe(audio)
                if not text:
                    sys.stderr.write("voice_in: empty transcription\n")
                    play_chime("end")
                    continue

                sys.stderr.write(f"voice_in: heard: {text}\n")
                sys.stderr.flush()
                log_inbound(text)

                response = send_to_jarvis(text)
                if response:
                    queue_speech(response)
                    sys.stderr.write(f"voice_in: response queued for speech\n")

                play_chime("end")


if __name__ == "__main__":
    main()
