from pathlib import Path

from fastapi.testclient import TestClient

from zaru.config import Settings
from zaru.main import create_app


def make_client(static_dir: Path) -> TestClient:
    return TestClient(create_app(Settings(static_dir=static_dir)))


def test_healthz(tmp_path: Path) -> None:
    res = make_client(tmp_path / "missing").get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_serves_mode_pages(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("picker")
    for mode in ("see", "hear"):
        (tmp_path / mode).mkdir()
        (tmp_path / mode / "index.html").write_text(mode)

    client = make_client(tmp_path)
    assert client.get("/").text == "picker"
    for mode in ("see", "hear"):
        redirect = client.get(f"/{mode}", follow_redirects=False)
        assert redirect.status_code == 308
        assert redirect.headers["location"] == f"/{mode}/"
        assert client.get(f"/{mode}/").text == mode


def test_runs_without_web_build(tmp_path: Path) -> None:
    res = make_client(tmp_path / "missing").get("/")
    assert res.status_code == 200
