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

    # Built PWA. In Docker this is /app/static; locally it falls back to web/dist.
    static_dir: Path = REPO_DIR / "web" / "dist"

    deployment_environment: str = "development"


@lru_cache
def get_settings() -> Settings:
    return Settings()
