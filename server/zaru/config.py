from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = SERVER_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=SERVER_DIR / ".env", extra="ignore")

    openai_api_key: str = ""
    openai_vision_model: str = ""
    openai_live_transcribe_model: str = "gpt-live-transcribe"
    openai_transcribe_model: str = "gpt-transcribe"
    openai_realtime_url: str = "wss://api.openai.com/v1/realtime?intent=transcription"

    # Captions: "auto" uses OpenAI when a key is set and reachable, else the local model.
    transcription_backend: str = "auto"  # auto | openai | local
    local_whisper_model: str = "small.en"
    # 1 = greedy. Beam search (5) measured no more accurate on noisy jargon with small.en
    # and ~50% slower, so greedy is the default.
    local_whisper_beam_size: int = 1
    # Where the Whisper model lives (baked into the Docker image); None = Hugging Face cache.
    whisper_model_dir: str | None = None

    # Built PWA. In Docker this is /app/static; locally it falls back to web/dist.
    static_dir: Path = REPO_DIR / "web" / "dist"

    deployment_environment: str = "development"


@lru_cache
def get_settings() -> Settings:
    return Settings()
