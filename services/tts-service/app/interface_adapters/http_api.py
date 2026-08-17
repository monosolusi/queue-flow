"""FastAPI routes -- the only surface the TV board and admin panel consume.

Routes are declared WITH the `/tts` prefix rather than having nginx strip it. That
mirrors core-api, whose controllers bake the prefix in (`@Controller('api/health')`)
so the gateway can `proxy_pass` with no trailing slash and no rewrite. Keeping the
same shape means one URL works identically in Vite dev (proxy, no rewrite) and
behind the gateway; stripping the prefix in nginx would force a `rewrite` in the
dev proxy and let dev and production diverge.
"""

from __future__ import annotations

import logging
from typing import Callable

from fastapi import APIRouter, Header, HTTPException, Query, Response

from ..application.synthesize_announcement import (
    Announcement,
    SynthesizeAnnouncementUseCase,
)
from ..domain.announcement import AnnouncementRequest, InvalidAnnouncementError
from ..domain.tts_engine import TtsEngineError, VoiceNotAvailableError
from ..infrastructure.audio_post_processor import AudioProcessingError

logger = logging.getLogger(__name__)

#: Builds the silent autoplay-probe clip. Injected rather than imported so these
#: routes can be exercised without ffmpeg on the machine running the tests.
ProbeBuilder = Callable[[], bytes]

# Announcement audio is immutable for a given (settings, text) tuple, and the ETag
# already encodes all of that -- so a long max-age is safe and saves the LAN a
# round trip on "Panggil Ulang".
_AUDIO_CACHE_CONTROL = "public, max-age=86400"


def build_router(
    use_case: SynthesizeAnnouncementUseCase, probe_builder: ProbeBuilder
) -> APIRouter:
    router = APIRouter(prefix="/tts")

    @router.get("/health")
    def health() -> dict[str, str]:
        """Liveness only -- deliberately independent of the model and the cache.

        The exact body `{"status": "ok"}` is a contract: the compose healthcheck and
        `scripts/verify-topology.mjs` both match the literal substring
        `"status":"ok"`. Do not enrich this payload; add fields to /tts/voices
        instead, which fails loudly when an engine is broken.
        """
        return {"status": "ok"}

    @router.get("/voices")
    def voices() -> dict[str, object]:
        """Selectable voices across every configured engine, for the admin panel."""
        return {"voices": use_case.available_voices()}

    @router.get("/announcement")
    def announcement(
        ticketNumber: str = Query(..., min_length=1, max_length=32),  # noqa: N803
        counterId: int = Query(..., ge=1),  # noqa: N803
        if_none_match: str | None = Header(default=None, alias="if-none-match"),
    ) -> Response:
        """The TV board's single request per called ticket."""
        request = _parse(ticketNumber, counterId)
        result = _synthesize(lambda: use_case.execute(request))
        return _audio_response(result, if_none_match)

    @router.get("/preview")
    def preview(
        text: str = Query(..., min_length=1, max_length=200),
        if_none_match: str | None = Header(default=None, alias="if-none-match"),
    ) -> Response:
        """Admin "Tes Suara": hear the current voice without calling a real ticket."""
        result = _synthesize(lambda: use_case.preview(text))
        return _audio_response(result, if_none_match)

    @router.get("/probe")
    def probe() -> Response:
        """A silent clip the TV plays to detect and lift the browser autoplay block.

        The TV needs audio it can legitimately `play()` on mount to learn whether
        the browser will allow sound at all, and again inside the user's tap so the
        gesture grants playback permission. Silent so it is inaudible in the store.
        """
        try:
            payload = probe_builder()
        except AudioProcessingError as exc:  # pragma: no cover - env failure
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return Response(
            content=payload,
            media_type="audio/mpeg",
            headers={"Cache-Control": "public, max-age=604800"},
        )

    return router


def _parse(ticket_number: str, counter_id: int) -> AnnouncementRequest:
    try:
        return AnnouncementRequest(
            ticket_number=ticket_number.strip(), counter_id=counter_id
        )
    except InvalidAnnouncementError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _synthesize(action) -> Announcement:
    try:
        return action()
    except InvalidAnnouncementError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except VoiceNotAvailableError as exc:
        # 503, not 500: the service is fine, its configured voice is not installed.
        # Distinguishing them is what tells an operator to fix config rather than
        # file a bug.
        logger.error("configured voice unavailable: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (TtsEngineError, AudioProcessingError) as exc:
        logger.exception("announcement synthesis failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except KeyError as exc:
        logger.error("unknown engine configured: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _audio_response(result: Announcement, if_none_match: str | None) -> Response:
    etag = f'"{result.etag}"'
    if if_none_match and etag in {tag.strip() for tag in if_none_match.split(",")}:
        return Response(status_code=304, headers={"ETag": etag})
    return Response(
        content=result.mp3,
        media_type="audio/mpeg",
        headers={
            "ETag": etag,
            "Cache-Control": _AUDIO_CACHE_CONTROL,
            # Surfaced for debugging: it makes "why does the board say that?"
            # answerable from curl -I without reading server logs.
            "X-Announcement-Text": result.text,
            "X-Announcement-Cached": "1" if result.cached else "0",
        },
    )
