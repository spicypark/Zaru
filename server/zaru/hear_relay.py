"""Hear mode: relay phone microphone audio to OpenAI realtime transcription.

Client -> server over /ws/hear:
  - binary frames: mono PCM16 little-endian at 24 kHz (~100 ms each)
  - text frames (JSON): {"type": "speech_start"} when the phone's voice detector hears speech,
    {"type": "commit"} at the end of a spoken turn (pause, or a cap on long turns)

Server -> client (JSON):
  {"type": "ready"} | {"type": "delta", "item": id, "text": str}
  | {"type": "final", "item": id, "text": str} | {"type": "failed", "item": id}
  | {"type": "error", "code": str}

Transcription uses turn_detection=null, so a final transcript only arrives after we send
input_audio_buffer.commit. Transcript text is forwarded to the phone and never logged or
attached to telemetry.
"""

import asyncio
import base64
import contextlib
import json
import logging
import time
from collections import deque

from fastapi import WebSocket, WebSocketDisconnect
from opentelemetry.trace import Status, StatusCode
from websockets.asyncio.client import ClientConnection, connect

from zaru.config import Settings
from zaru.telemetry import meter, tracer

log = logging.getLogger(__name__)

SAMPLE_RATE = 24_000
BYTES_PER_SECOND = SAMPLE_RATE * 2
# OpenAI rejects commits of less than 100 ms of audio.
MIN_COMMIT_BYTES = BYTES_PER_SECOND // 10

caption_latency = meter.create_histogram(
    "zaru.caption.latency_ms",
    unit="ms",
    description="End of a spoken turn (commit) to its first caption text sent to the phone",
)
final_latency = meter.create_histogram(
    "zaru.caption.final_latency_ms",
    unit="ms",
    description="End of a spoken turn (commit) to its final transcript",
)
active_sessions = meter.create_up_down_counter(
    "zaru.hear.active_sessions", description="Open Hear mode sessions"
)
audio_seconds = meter.create_counter(
    "zaru.hear.audio_seconds", unit="s", description="Audio streamed to transcription"
)
segments = meter.create_counter(
    "zaru.hear.segments", description="Spoken turns transcribed, by outcome"
)


def session_update(model: str) -> dict:
    return {
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    "transcription": {"model": model},
                    "turn_detection": None,
                }
            },
        },
    }


class _Turns:
    """Matches commits to OpenAI items (commits are acknowledged in order) to time captions."""

    def __init__(self) -> None:
        self.pending_commits: deque[float] = deque()
        self.commit_time: dict[str, float] = {}
        self.has_text: set[str] = set()

    def committed(self, item_id: str) -> None:
        if self.pending_commits:
            self.commit_time[item_id] = self.pending_commits.popleft()

    def first_text(self, item_id: str) -> None:
        if item_id in self.has_text:
            return
        self.has_text.add(item_id)
        if (t := self.commit_time.get(item_id)) is not None:
            caption_latency.record((time.monotonic() - t) * 1000)

    def finished(self, item_id: str, outcome: str) -> None:
        if outcome == "ok":
            self.first_text(item_id)
            if (t := self.commit_time.get(item_id)) is not None:
                final_latency.record((time.monotonic() - t) * 1000)
        self.commit_time.pop(item_id, None)
        self.has_text.discard(item_id)
        segments.add(1, {"outcome": outcome})


async def _phone_to_openai(ws: WebSocket, upstream: ClientConnection, turns: _Turns) -> None:
    uncommitted = 0
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return
        if (chunk := msg.get("bytes")) is not None:
            uncommitted += len(chunk)
            audio_seconds.add(len(chunk) / BYTES_PER_SECOND)
            await upstream.send(
                json.dumps(
                    {"type": "input_audio_buffer.append", "audio": base64.b64encode(chunk).decode()}
                )
            )
            continue
        try:
            control = json.loads(msg.get("text") or "{}")
        except json.JSONDecodeError:
            continue
        if control.get("type") == "commit" and uncommitted >= MIN_COMMIT_BYTES:
            turns.pending_commits.append(time.monotonic())
            uncommitted = 0
            await upstream.send(json.dumps({"type": "input_audio_buffer.commit"}))


async def _openai_to_phone(ws: WebSocket, upstream: ClientConnection, turns: _Turns) -> None:
    async for raw in upstream:
        event = json.loads(raw)
        kind = event.get("type", "")
        item = event.get("item_id", "")
        if kind == "input_audio_buffer.committed":
            turns.committed(item)
        elif kind == "conversation.item.input_audio_transcription.delta":
            turns.first_text(item)
            await ws.send_json({"type": "delta", "item": item, "text": event.get("delta", "")})
        elif kind == "conversation.item.input_audio_transcription.completed":
            turns.finished(item, "ok")
            await ws.send_json({"type": "final", "item": item, "text": event.get("transcript", "")})
        elif kind == "conversation.item.input_audio_transcription.failed":
            turns.finished(item, "failed")
            await ws.send_json({"type": "failed", "item": item})
        elif kind == "error":
            # Log the error code/type only; messages can echo request content.
            err = event.get("error") or {}
            code = str(err.get("code") or err.get("type") or "unknown")
            log.warning("openai realtime error: %s", code)
            await ws.send_json({"type": "error", "code": code})


async def hear_session(ws: WebSocket, settings: Settings) -> None:
    await ws.accept()
    if not settings.openai_api_key:
        await ws.send_json({"type": "error", "code": "missing_api_key"})
        await ws.close(code=1011)
        return

    active_sessions.add(1)
    with tracer.start_as_current_span("zaru.hear.session") as span:
        span.set_attribute("zaru.transcribe.model", settings.openai_live_transcribe_model)
        started = time.monotonic()
        try:
            async with connect(
                settings.openai_realtime_url,
                additional_headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                max_size=None,
            ) as upstream:
                await upstream.send(
                    json.dumps(session_update(settings.openai_live_transcribe_model))
                )
                await ws.send_json({"type": "ready"})
                turns = _Turns()
                tasks = [
                    asyncio.create_task(_phone_to_openai(ws, upstream, turns)),
                    asyncio.create_task(_openai_to_phone(ws, upstream, turns)),
                ]
                try:
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        if (exc := task.exception()) and not isinstance(exc, WebSocketDisconnect):
                            raise exc
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            span.record_exception(exc)
            span.set_status(Status(StatusCode.ERROR))
            log.warning("hear session failed: %s", type(exc).__name__)
            with contextlib.suppress(Exception):
                await ws.send_json({"type": "error", "code": "upstream_unavailable"})
        finally:
            span.set_attribute("zaru.hear.duration_s", round(time.monotonic() - started, 1))
            active_sessions.add(-1)
            with contextlib.suppress(Exception):
                await ws.close()
