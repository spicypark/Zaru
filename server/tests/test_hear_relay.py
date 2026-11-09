"""Hear relay against a fake OpenAI realtime transcription server."""

import asyncio
import base64
import json
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from websockets.asyncio.server import ServerConnection, serve

from zaru import hear_relay
from zaru.config import Settings
from zaru.main import create_app


class FakeOpenAI:
    def __init__(self) -> None:
        self.received: list[dict] = []
        self.reject_key = False
        self.auth: str | None = None
        self.port = 0
        self._ready = threading.Event()
        self._loop = asyncio.new_event_loop()
        self._stop: asyncio.Future | None = None

    async def _handler(self, conn: ServerConnection) -> None:
        self.auth = conn.request.headers.get("Authorization")
        async for raw in conn:
            event = json.loads(raw)
            self.received.append(event)
            if self.reject_key and event["type"] == "session.update":
                await conn.send(json.dumps({"type": "error", "error": {"code": "invalid_api_key"}}))
                continue
            if event["type"] == "input_audio_buffer.commit":
                item = (
                    f"item_{sum(e['type'] == 'input_audio_buffer.commit' for e in self.received)}"
                )
                await conn.send(
                    json.dumps({"type": "input_audio_buffer.committed", "item_id": item})
                )
                for delta in ("hello ", "world"):
                    await conn.send(
                        json.dumps(
                            {
                                "type": "conversation.item.input_audio_transcription.delta",
                                "item_id": item,
                                "delta": delta,
                            }
                        )
                    )
                await conn.send(
                    json.dumps(
                        {
                            "type": "conversation.item.input_audio_transcription.completed",
                            "item_id": item,
                            "transcript": "hello world",
                        }
                    )
                )

    async def _main(self) -> None:
        self._stop = self._loop.create_future()
        async with serve(self._handler, "127.0.0.1", 0) as server:
            self.port = server.sockets[0].getsockname()[1]
            self._ready.set()
            await self._stop

    def __enter__(self) -> "FakeOpenAI":
        threading.Thread(
            target=self._loop.run_until_complete, args=(self._main(),), daemon=True
        ).start()
        self._ready.wait(5)
        return self

    def __exit__(self, *_: object) -> None:
        self._loop.call_soon_threadsafe(self._stop.set_result, None)


@pytest.fixture
def fake_openai() -> Iterator[FakeOpenAI]:
    with FakeOpenAI() as fake:
        yield fake


def client_for(fake: FakeOpenAI, tmp_path: Path, key: str = "sk-test") -> TestClient:
    settings = Settings(
        openai_api_key=key,
        openai_realtime_url=f"ws://127.0.0.1:{fake.port}",
        static_dir=tmp_path / "missing",
    )
    return TestClient(create_app(settings))


def test_relays_audio_and_returns_captions(fake_openai: FakeOpenAI, tmp_path: Path) -> None:
    pcm = b"\x01\x00" * 2400  # 100 ms of 24 kHz PCM16
    with client_for(fake_openai, tmp_path).websocket_connect("/ws/hear") as ws:
        assert ws.receive_json() == {"type": "ready", "backend": "openai"}
        ws.send_text(json.dumps({"type": "speech_start"}))
        ws.send_bytes(pcm)
        ws.send_text(json.dumps({"type": "commit", "turn": 7, "attributed": True}))
        assert ws.receive_json() == {
            "type": "delta",
            "item": "item_1",
            "turn": 7,
            "text": "hello ",
        }
        assert ws.receive_json() == {"type": "delta", "item": "item_1", "turn": 7, "text": "world"}
        assert ws.receive_json() == {
            "type": "final",
            "item": "item_1",
            "turn": 7,
            "text": "hello world",
        }

    types = [e["type"] for e in fake_openai.received]
    assert types == ["session.update", "input_audio_buffer.append", "input_audio_buffer.commit"]
    session = fake_openai.received[0]["session"]
    assert session["type"] == "transcription"
    assert session["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 24000}
    assert session["audio"]["input"]["turn_detection"] is None
    assert base64.b64decode(fake_openai.received[1]["audio"]) == pcm
    assert fake_openai.auth == "Bearer sk-test"


def test_skips_commit_with_too_little_audio(fake_openai: FakeOpenAI, tmp_path: Path) -> None:
    with client_for(fake_openai, tmp_path).websocket_connect("/ws/hear") as ws:
        assert ws.receive_json() == {"type": "ready", "backend": "openai"}
        ws.send_bytes(b"\x00\x00" * 100)  # ~4 ms
        ws.send_text(json.dumps({"type": "commit"}))
    assert "input_audio_buffer.commit" not in [e["type"] for e in fake_openai.received]


class FakeTranscriber:
    def __init__(self) -> None:
        self.calls: list[bytes] = []
        self.contexts: list[str] = []

    async def transcribe(
        self, pcm16: bytes, deadline: float | None = None, context: str = ""
    ) -> str | None:
        self.calls.append(pcm16)
        self.contexts.append(context)
        return "local words"


@pytest.fixture(autouse=True)
def local_stt(monkeypatch: pytest.MonkeyPatch) -> FakeTranscriber:
    fake = FakeTranscriber()
    monkeypatch.setattr(hear_relay, "get_local_transcriber", lambda _settings: fake)
    monkeypatch.setattr(hear_relay, "_openai_down_until", 0.0)
    return fake


def speak_one_turn(ws, turn: int = 1) -> None:
    ws.send_text(json.dumps({"type": "speech_start"}))
    ws.send_bytes(b"\x01\x00" * 2400)
    ws.send_text(json.dumps({"type": "commit", "turn": turn}))


def test_uses_local_model_without_api_key(
    fake_openai: FakeOpenAI, local_stt: FakeTranscriber, tmp_path: Path
) -> None:
    with client_for(fake_openai, tmp_path, key="").websocket_connect("/ws/hear") as ws:
        assert ws.receive_json() == {"type": "ready", "backend": "local"}
        speak_one_turn(ws)
        assert ws.receive_json() == {
            "type": "final",
            "item": "local_1",
            "turn": 1,
            "text": "local words",
        }
    assert local_stt.calls == [b"\x01\x00" * 2400]
    assert fake_openai.received == []


def test_falls_back_to_local_when_openai_unreachable(tmp_path: Path) -> None:
    settings = Settings(
        openai_api_key="sk-test",
        openai_realtime_url="ws://127.0.0.1:9",  # nothing listens here
        static_dir=tmp_path / "missing",
    )
    with TestClient(create_app(settings)).websocket_connect("/ws/hear") as ws:
        assert ws.receive_json() == {"type": "ready", "backend": "local"}
        speak_one_turn(ws)
        assert ws.receive_json()["text"] == "local words"


def test_falls_back_to_local_when_key_rejected(fake_openai: FakeOpenAI, tmp_path: Path) -> None:
    fake_openai.reject_key = True
    client = client_for(fake_openai, tmp_path)
    with client.websocket_connect("/ws/hear") as ws:
        assert ws.receive_json() == {"type": "ready", "backend": "openai"}
        assert ws.receive_json() == {"type": "ready", "backend": "local"}
        speak_one_turn(ws)
        assert ws.receive_json()["text"] == "local words"
    # New sessions skip OpenAI for a while after a fatal error.
    with client.websocket_connect("/ws/hear") as ws:
        assert ws.receive_json() == {"type": "ready", "backend": "local"}


def test_local_skips_turns_that_waited_too_long(
    fake_openai: FakeOpenAI,
    local_stt: FakeTranscriber,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(hear_relay, "MAX_LOCAL_QUEUE_AGE_S", -1.0)  # every turn is "stale"
    with client_for(fake_openai, tmp_path, key="").websocket_connect("/ws/hear") as ws:
        assert ws.receive_json() == {"type": "ready", "backend": "local"}
        speak_one_turn(ws)
    assert local_stt.calls == []


def test_whisper_transcriber_skips_turn_whose_deadline_passed_while_waiting() -> None:
    import asyncio
    import time

    from zaru.local_stt import WhisperTranscriber

    transcriber = WhisperTranscriber(Settings())

    async def run() -> str | None:
        await transcriber._run_lock.acquire()  # another phone is using the model
        task = asyncio.create_task(transcriber.transcribe(b"\x00\x00", time.monotonic() + 0.05))
        await asyncio.sleep(0.1)
        transcriber._run_lock.release()
        return await task

    assert asyncio.run(run()) is None


def test_local_passes_previous_caption_as_context(
    fake_openai: FakeOpenAI, local_stt: FakeTranscriber, tmp_path: Path
) -> None:
    with client_for(fake_openai, tmp_path, key="").websocket_connect("/ws/hear") as ws:
        assert ws.receive_json()["backend"] == "local"
        speak_one_turn(ws, turn=1)
        assert ws.receive_json()["turn"] == 1
        speak_one_turn(ws, turn=2)
        second = ws.receive_json()
        assert (second["item"], second["turn"]) == ("local_2", 2)
    assert local_stt.contexts == ["", "local words"]
