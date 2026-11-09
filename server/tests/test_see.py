import base64
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from zaru import see
from zaru.config import Settings
from zaru.main import create_app

JPEG = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8fakejpeg\xff\xd9").decode()
WAV = base64.b64encode(b"RIFF" + b"\x00" * 200).decode()


class FakeOpenAI:
    def __init__(self, scene: see.Scene, question: str = "what room is this") -> None:
        self.scene = scene
        self.question = question
        self.calls: list[dict] = []
        self.responses = SimpleNamespace(parse=self._parse)
        self.audio = SimpleNamespace(transcriptions=SimpleNamespace(create=self._transcribe))

    async def _parse(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(output_parsed=self.scene)

    async def _transcribe(self, **kwargs):
        return SimpleNamespace(text=self.question)


def scene(**overrides) -> see.Scene:
    base = dict(
        visible="A brown door with a blue sign reading Room 151 and a person.",
        hazards=[],
        people=["One person at 12 o'clock, 2 metres away"],
        text=["Room 151"],
        scene="A hallway with a door labelled Room 151.",
        changed=True,
        priority="text",
        speak="Door ahead labelled Room 151.",
    )
    return see.Scene(**{**base, **overrides})


def client_with(fake: FakeOpenAI, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(see, "get_openai", lambda _settings: fake)
    return TestClient(create_app(Settings(static_dir=tmp_path / "missing")))


def test_describe_returns_spoken_summary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeOpenAI(scene())
    res = client_with(fake, tmp_path, monkeypatch).post(
        "/api/see/describe", json={"image": JPEG, "mode": "describe"}
    )
    assert res.status_code == 200
    assert res.json()["speak"] == "Door ahead labelled Room 151."
    content = fake.calls[0]["input"][0]["content"]
    assert content[1]["image_url"].startswith("data:image/jpeg;base64,")
    assert "Describe what's around me" in content[0]["text"]


def test_auto_mode_stays_quiet_when_nothing_changed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeOpenAI(scene(changed=False, speak="Still a hallway."))
    res = client_with(fake, tmp_path, monkeypatch).post(
        "/api/see/describe",
        json={"image": JPEG, "mode": "auto", "previous": "A hallway.", "reason": "motion"},
    )
    assert res.json() == {
        "speak": "",
        "priority": "none",
        "changed": False,
        "scene": "A hallway with a door labelled Room 151.",
        "question": None,
    }
    assert (
        'The last thing you told the user was: "A hallway."'
        in (fake.calls[0]["input"][0]["content"][0]["text"])
    )


def test_ask_transcribes_then_answers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeOpenAI(scene(speak="This is Room 151."), question="What room is this?")
    res = client_with(fake, tmp_path, monkeypatch).post(
        "/api/see/ask", json={"image": JPEG, "audio": WAV}
    )
    body = res.json()
    assert body["question"] == "What room is this?"
    assert body["speak"] == "This is Room 151."
    assert (
        'The user asked about this view: "What room is this?"'
        in (fake.calls[0]["input"][0]["content"][0]["text"])
    )


def test_rejects_invalid_image(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    res = client_with(FakeOpenAI(scene()), tmp_path, monkeypatch).post(
        "/api/see/describe", json={"image": "not base64!!", "mode": "describe"}
    )
    assert res.status_code == 400


def test_reports_unconfigured_without_key(tmp_path: Path) -> None:
    app = create_app(Settings(openai_api_key="", static_dir=tmp_path / "missing"))
    res = TestClient(app).post("/api/see/describe", json={"image": JPEG})
    assert res.status_code == 503


def test_temperature_only_sent_to_models_that_accept_it() -> None:
    assert see._sampling_options("gpt-4.1-mini") == {"temperature": 0}
    for model in ("gpt-5.4-mini", "o4-mini", "o3"):
        assert see._sampling_options(model) == {}


def test_update_mode_always_speaks_and_reports_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeOpenAI(scene(changed=False, priority="scene", speak="Still facing a wooden table."))
    res = client_with(fake, tmp_path, monkeypatch).post(
        "/api/see/describe",
        json={"image": JPEG, "mode": "update", "previous": "A wooden table."},
    )
    body = res.json()
    assert body["speak"] == "Still facing a wooden table."
    assert body["changed"] is False
    assert "running narration" in fake.calls[0]["input"][0]["content"][0]["text"]


def test_update_reminder_uses_short_reminder_prompt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeOpenAI(scene(changed=False, priority="scene", speak="Still a door ahead."))
    client_with(fake, tmp_path, monkeypatch).post(
        "/api/see/describe",
        json={"image": JPEG, "mode": "update", "previous": "A door ahead.", "reason": "reminder"},
    )
    assert "hasn't heard anything for a while" in fake.calls[0]["input"][0]["content"][0]["text"]
