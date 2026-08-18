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
    UnknownTtsEngineError,
)
from ..domain.announcement import AnnouncementRequest, InvalidAnnouncementError
from ..domain.ports import AudioFinishingError
from ..domain.tts_engine import TtsEngineError, TtsSettings, VoiceNotAvailableError

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
        """Selectable voices across every configured engine, for the admin panel.

        Flattening to the wire shape happens HERE, not in the use case: the JSON a
        dropdown wants is a presentation decision.
        """
        return {
            "voices": [
                {
                    "engine": entry.engine,
                    "id": entry.voice.id,
                    "label": entry.voice.label,
                    "language": entry.voice.language,
                }
                for entry in use_case.available_voices()
            ]
        }

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
        text: str | None = Query(default=None, min_length=1, max_length=200),
        speed: float | None = Query(default=None, ge=0.25, le=4.0),
        volume: float | None = Query(default=None, ge=0.0, le=2.0),
        pauseMs: int | None = Query(default=None, ge=0, le=2000),  # noqa: N803
        if_none_match: str | None = Header(default=None, alias="if-none-match"),
    ) -> Response:
        """Admin "Tes Suara": hear the announcement without calling a real ticket.

        `text` is optional. Omitted, the domain builds a sample announcement, so
        the admin panel never has to know how a queue call is worded in
        Indonesian -- that knowledge lives in this service and nowhere else.

        `speed`/`volume`/`pauseMs` audition UNSAVED values so a manager can hear a
        setting before committing to it. They stay bounded by FastAPI at the
        engine's own limits (the admin panel offers a narrower range still), and
        the digest already folds delivery knobs in, so an auditioned clip cannot
        be served in place of a real announcement.
        """
        overrides = _overrides(use_case, speed, volume)
        result = _synthesize(
            lambda: use_case.preview(text, overrides=overrides, pause_ms=pauseMs)
        )
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
        except AudioFinishingError as exc:  # pragma: no cover - env failure
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return Response(
            content=payload,
            media_type="audio/mpeg",
            headers={"Cache-Control": "public, max-age=604800"},
        )

    return router


def _overrides(
    use_case: SynthesizeAnnouncementUseCase, speed: float | None, volume: float | None
) -> TtsSettings | None:
    """Build a settings override, or None when nothing was auditioned.

    Returning None rather than a fully-defaulted `TtsSettings` matters: the use
    case treats None as "use the stored config", which keeps the voice and the
    un-auditioned knob at whatever the store actually has. Building a settings
    object here would mean guessing a voice id, and guessing it wrong would make
    the preview a test of the wrong voice.
    """
    if speed is None and volume is None:
        return None
    current = use_case.current_settings()
    return TtsSettings(
        voice_id=current.voice_id,
        speed=current.speed if speed is None else speed,
        volume=current.volume if volume is None else volume,
    )


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
    except UnknownTtsEngineError as exc:
        # 503 for the same reason as a missing voice: config is wrong, not the code.
        # Caught before the generic 500 branch, and a dedicated type rather than a
        # bare `KeyError` so an unrelated KeyError from deeper down is reported as
        # the server fault it is instead of sending the operator to the config page.
        logger.error("unknown engine configured: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (TtsEngineError, AudioFinishingError) as exc:
        logger.exception("announcement synthesis failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _audio_response(result: Announcement, if_none_match: str | None) -> Response:
    etag = f'"{result.cache_key}"'
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
