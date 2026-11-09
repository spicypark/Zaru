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

from zaru.config import Settings
from zaru.main import create_app


class FakeOpenAI:
    def __init__(self) -> None:
        self.received: list[dict] = []
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
        assert ws.receive_json() == {"type": "ready"}
        ws.send_text(json.dumps({"type": "speech_start"}))
        ws.send_bytes(pcm)
        ws.send_text(json.dumps({"type": "commit"}))
        assert ws.receive_json() == {"type": "delta", "item": "item_1", "text": "hello "}
        assert ws.receive_json() == {"type": "delta", "item": "item_1", "text": "world"}
        assert ws.receive_json() == {"type": "final", "item": "item_1", "text": "hello world"}

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
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(b"\x00\x00" * 100)  # ~4 ms
        ws.send_text(json.dumps({"type": "commit"}))
    assert "input_audio_buffer.commit" not in [e["type"] for e in fake_openai.received]


def test_reports_missing_api_key(fake_openai: FakeOpenAI, tmp_path: Path) -> None:
    with client_for(fake_openai, tmp_path, key="").websocket_connect("/ws/hear") as ws:
        assert ws.receive_json() == {"type": "error", "code": "missing_api_key"}
