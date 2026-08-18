"""Composition root: wires concrete infrastructure into the use case.

This is the only module that knows every concrete class. Everything below it
depends on abstractions (DIP), which is what makes the engine swappable.

Run locally:   uvicorn app.main:api --port 8000
In the image:   CMD ["uvicorn", "app.main:api", "--host", "0.0.0.0", "--port", "8000"]
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI

from .application.synthesize_announcement import SynthesizeAnnouncementUseCase
from .domain.tts_engine import TtsEngine
from .infrastructure.audio_cache import AudioCache
from .infrastructure.audio_post_processor import build_announcement_mp3
from .infrastructure.core_api_config_client import CoreApiConfigClient
from .infrastructure.piper_engine import ENGINE_ID as PIPER_ENGINE_ID
from .infrastructure.piper_engine import PiperTtsEngine
from .infrastructure.prerecorded_engine import ENGINE_ID as PRERECORDED_ENGINE_ID
from .infrastructure.prerecorded_engine import PrerecordedTtsEngine


def _env(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def build_use_case() -> SynthesizeAnnouncementUseCase:
    """Assemble the use case from environment configuration.

    Defaults are the local-dev paths; `docker-compose.yml` overrides them with the
    in-image locations. Both engines are always registered -- which one runs is
    decided per request by `ttsConfiguration`, so switching voices never needs a
    restart.
    """
    engines: dict[str, TtsEngine] = {
        PIPER_ENGINE_ID: PiperTtsEngine(_env("QMS_TTS_MODELS_DIR", "models")),
        PRERECORDED_ENGINE_ID: PrerecordedTtsEngine(
            _env("QMS_TTS_RECORDINGS_DIR", "recordings")
        ),
    }
    return SynthesizeAnnouncementUseCase(
        engines=engines,
        cache=AudioCache(Path(_env("QMS_TTS_CACHE_DIR", ".cache"))),
        finisher=build_announcement_mp3,
        config_provider=CoreApiConfigClient(
            _env("QMS_CORE_API_URL", "http://localhost:3000"),
            ttl_seconds=float(_env("QMS_TTS_CONFIG_TTL_SECONDS", "30")),
        ),
    )


def create_app() -> FastAPI:
    logging.basicConfig(
        level=_env("QMS_TTS_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # Imported here so the router module is not a hard dependency of importing this
    # module for tests that only want build_use_case().
    from .infrastructure.audio_post_processor import build_silent_mp3
    from .interface_adapters.http_api import build_router

    app = FastAPI(
        title="QMS TTS Service",
        description=(
            "Offline Indonesian announcement synthesis for the queue TV board. "
            "No internet at runtime (NFR-REL-01)."
        ),
        version="1.0.0",
        # No docs in production: this is a LAN appliance, not a public API, and an
        # unauthenticated schema browser is needless surface.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.include_router(build_router(build_use_case(), build_silent_mp3))
    return app


api = create_app()
