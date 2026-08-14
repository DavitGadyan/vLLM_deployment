"""Application settings, loaded from environment."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Serving ----------------------------------------------------------
    vllm_base_url: str = "http://vllm:8000/v1"
    vllm_api_key: str = "local-dev-key"
    served_model_name: str = "qwen-support"
    request_timeout_seconds: float = 120.0

    embeddings_base_url: str = "http://embeddings:8001/v1"
    embeddings_model: str = "BAAI/bge-small-en-v1.5"
    embeddings_dim: int = 384

    # --- Generation defaults (a config version may override these) ---------
    max_model_len: int = 8192
    max_output_tokens: int = 1024
    temperature: float = 0.2
    top_p: float = 0.9

    # --- Retrieval --------------------------------------------------------
    retrieval_top_k: int = 5
    # Cosine-similarity floor. Below this the assistant escalates rather than
    # answering from weakly-related text — see services/guardrails.py.
    retrieval_min_score: float = 0.35
    chunk_size_tokens: int = 512
    chunk_overlap_tokens: int = 64
    max_upload_bytes: int = 20 * 1024 * 1024

    # Budget for retrieved context, so a large top_k cannot crowd out the
    # conversation history and force truncation of the actual question.
    max_context_tokens: int = 3000

    # --- Database ---------------------------------------------------------
    database_url: str = "postgresql+asyncpg://support:support-dev-password@postgres:5432/support"
    db_pool_size: int = 10
    db_max_overflow: int = 5

    # --- Service ----------------------------------------------------------
    backend_port: int = 8080
    log_level: str = "INFO"
    log_format: str = "json"
    cors_allow_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    # Conversation history sent to the model, in turns (user+assistant pairs).
    # Older turns are dropped rather than summarised: summarisation would change
    # the prompt prefix on every turn and defeat prefix caching.
    history_turns: int = 6

    @field_validator("cors_allow_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @property
    def sync_database_url(self) -> str:
        """Alembic runs synchronously."""
        return self.database_url.replace("+asyncpg", "+psycopg2").replace(
            "postgresql+psycopg2", "postgresql"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
