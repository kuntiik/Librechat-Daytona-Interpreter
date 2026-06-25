from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    ADAPTER_API_KEY: str | None = None
    CODEAPI_AUTH_MODE: Literal["jwt", "api_key"] = "jwt"
    CODEAPI_JWT_PUBLIC_KEY_BASE64: str | None = None
    CODEAPI_JWT_ALGORITHM: str = "EdDSA"
    CODEAPI_JWT_ISSUER: str = "librechat"
    CODEAPI_JWT_AUDIENCE: str = "code-interpreter"
    CODEAPI_JWT_KID: str | None = None
    DAYTONA_API_KEY: str
    DAYTONA_API_URL: str | None = None
    DAYTONA_SANDBOX_CPU: int = 1
    DAYTONA_SANDBOX_MEMORY: int = 1
    DAYTONA_SANDBOX_DISK: int = 3
    # Custom sandbox image. When set, the adapter skips its per-session
    # pip-install priming — the image is expected to carry everything
    # the agent needs (see sandbox-image/Dockerfile).
    DAYTONA_SANDBOX_IMAGE: str | None = None
    WORKSPACE_ROOT: str = "/workspace"
    # Persistent, identity-keyed file storage on the adapter host. Files
    # uploaded with a `kind`/`id` identity land in BUCKET_ROOT/<bucket>/ and
    # are copied into the per-conversation sandbox on its first exec. Survives
    # sandbox reaping and adapter restarts; a relative path resolves against
    # the adapter's working directory.
    BUCKET_ROOT: str = "buckets"
    REDIS_URL: str | None = None
    SESSION_TTL_SECONDS: int = 300
    CLEANUP_INTERVAL_SECONDS: int = 60
    UPLOAD_MAX_BYTES: int = 20 * 1024 * 1024
    LOG_LEVEL: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
