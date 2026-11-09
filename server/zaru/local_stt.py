"""Local speech-to-text fallback using faster-whisper on the server CPU.

Used when no OpenAI key is configured or OpenAI is unreachable. Audio never leaves the server
and is discarded after transcription.
"""

import asyncio
import logging
import re
import threading
import time
from typing import Protocol

import numpy as np

from zaru.config import Settings
from zaru.telemetry import meter, tracer

log = logging.getLogger(__name__)

INPUT_RATE = 24_000
WHISPER_RATE = 16_000

# Whisper's well-known outputs for silence/noise; dropped when they are the whole caption.
_HALLUCINATIONS = {
    "you",
    "thank you",
    "thanks for watching",
    "thank you for watching",
    "bye",
    "okay",
}

local_latency = meter.create_histogram(
    "zaru.stt.local.duration_ms", unit="ms", description="Local Whisper transcription time"
)


class Transcriber(Protocol):
    async def transcribe(self, pcm16: bytes) -> str: ...


def pcm16_24k_to_float_16k(pcm16: bytes) -> np.ndarray:
    audio = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size == 0:
        return audio
    target = int(round(audio.size * WHISPER_RATE / INPUT_RATE))
    positions = np.linspace(0, audio.size - 1, num=target, dtype=np.float32)
    return np.interp(positions, np.arange(audio.size, dtype=np.float32), audio).astype(np.float32)


def _is_hallucination(text: str) -> bool:
    return re.sub(r"[^a-z ]", "", text.lower()).strip() in _HALLUCINATIONS


class WhisperTranscriber:
    """Loads the model once (lazily, in a thread) and transcribes one turn at a time."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._model = None
        self._load_lock = threading.Lock()
        # One transcription at a time: parallel runs on a small CPU only make each one slower.
        self._run_lock = asyncio.Lock()

    def _load(self):
        with self._load_lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                started = time.monotonic()
                self._model = WhisperModel(
                    self._settings.local_whisper_model,
                    device="cpu",
                    compute_type="int8",
                    download_root=self._settings.whisper_model_dir,
                )
                log.info("whisper model loaded in %.1fs", time.monotonic() - started)
            return self._model

    def warm_up(self) -> None:
        threading.Thread(target=self._load, daemon=True).start()

    def _transcribe_sync(self, pcm16: bytes) -> str:
        model = self._load()
        segments, _ = model.transcribe(
            pcm16_24k_to_float_16k(pcm16),
            language="en",
            beam_size=1,
            condition_on_previous_text=False,
            without_timestamps=True,
            vad_filter=False,
        )
        segments = list(segments)
        kept = [
            s.text.strip()
            for s in segments
            if not (s.no_speech_prob > 0.6 and s.avg_logprob < -0.8)
        ]
        text = " ".join(t for t in kept if t).strip()
        # "Thank you." / "Okay." are often real speech; drop them only when Whisper also
        # doubted there was any speech in the turn.
        doubtful = max((s.no_speech_prob for s in segments), default=1.0) > 0.3
        return "" if doubtful and _is_hallucination(text) else text

    async def transcribe(self, pcm16: bytes) -> str:
        async with self._run_lock:
            with tracer.start_as_current_span("zaru.stt.local") as span:
                span.set_attribute("zaru.audio.ms", len(pcm16) * 1000 // (INPUT_RATE * 2))
                started = time.monotonic()
                text = await asyncio.to_thread(self._transcribe_sync, pcm16)
                elapsed = (time.monotonic() - started) * 1000
                local_latency.record(elapsed)
                span.set_attribute("zaru.caption.chars", len(text))
                return text


_instance: WhisperTranscriber | None = None


def get_local_transcriber(settings: Settings) -> Transcriber:
    global _instance
    if _instance is None:
        _instance = WhisperTranscriber(settings)
    return _instance
