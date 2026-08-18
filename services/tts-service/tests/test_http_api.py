"""The HTTP contract the TV board and admin panel depend on."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.application.synthesize_announcement import SynthesizeAnnouncementUseCase
from app.domain.tts_engine import TtsEngineError, VoiceNotAvailableError
from app.interface_adapters.http_api import build_router

from .fakes import FakeCache, FakeConfig, FakeConfigProvider, FakeEngine, fake_finisher

PROBE_BYTES = b"MP3::SILENT"


def build_client(
    *, engine: FakeEngine | None = None, config: FakeConfig | None = None
) -> TestClient:
    engine = engine or FakeEngine()
    use_case = SynthesizeAnnouncementUseCase(
        engines={engine.id: engine},
        cache=FakeCache(),
        finisher=fake_finisher,
        config_provider=FakeConfigProvider(config or FakeConfig(engine=engine.id)),
    )
    app = FastAPI()
    app.include_router(build_router(use_case, lambda: PROBE_BYTES))
    return TestClient(app)


def test_health_returns_exactly_the_literal_the_gates_match_on() -> None:
    """`docker-compose.yml` and `verify-topology.mjs` both grep for `"status":"ok"`.

    Enriching this payload would silently break the compose healthcheck and the
    topology smoke test, so the shape is pinned here.
    """
    response = build_client().get("/tts/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert '"status":"ok"' in response.text.replace(" ", "")


def test_announcement_returns_audio_for_a_called_ticket() -> None:
    response = build_client().get(
        "/tts/announcement", params={"ticketNumber": "A-005", "counterId": 2}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.content.startswith(b"MP3::BELL::")


def test_announcement_exposes_the_spoken_text_for_debugging() -> None:
    response = build_client().get(
        "/tts/announcement", params={"ticketNumber": "A-005", "counterId": 2}
    )
    assert (
        response.headers["x-announcement-text"]
        == "nomor antrian a lima, silakan ke loket dua"
    )


def test_announcement_is_etagged_and_revalidates_with_304() -> None:
    """Saves re-sending ~40 KB on every "Panggil Ulang" over the LAN."""
    client = build_client()
    params = {"ticketNumber": "A-005", "counterId": 2}

    first = client.get("/tts/announcement", params=params)
    etag = first.headers["etag"]
    assert etag.startswith('"')

    second = client.get(
        "/tts/announcement", params=params, headers={"If-None-Match": etag}
    )
    assert second.status_code == 304
    assert second.content == b""


def test_announcement_reports_whether_it_was_cached() -> None:
    client = build_client()
    params = {"ticketNumber": "A-007", "counterId": 1}
    assert client.get("/tts/announcement", params=params).headers[
        "x-announcement-cached"
    ] == "0"
    assert client.get("/tts/announcement", params=params).headers[
        "x-announcement-cached"
    ] == "1"


@pytest.mark.parametrize(
    "params",
    [
        {"ticketNumber": "A-005"},  # missing counterId
        {"counterId": 2},  # missing ticketNumber
        {"ticketNumber": "A-005", "counterId": 0},  # counters start at 1
        {"ticketNumber": "A-005", "counterId": -3},
        {"ticketNumber": "", "counterId": 2},
        {"ticketNumber": "A-005", "counterId": "dua"},
    ],
)
def test_announcement_rejects_malformed_requests_with_4xx(params: dict) -> None:
    """A bad request must never surface as a 500 -- that would read as our bug."""
    response = build_client().get("/tts/announcement", params=params)
    assert 400 <= response.status_code < 500


def test_announcement_rejects_a_ticket_number_with_no_letters() -> None:
    response = build_client().get(
        "/tts/announcement", params={"ticketNumber": "123", "counterId": 1}
    )
    assert response.status_code == 400


def test_a_missing_voice_is_503_not_500() -> None:
    """The service is healthy; its configured voice is not installed.

    The distinction is what tells an operator to fix configuration rather than
    report a crash.
    """
    engine = FakeEngine(fail_with=VoiceNotAvailableError("no such voice"))
    response = build_client(engine=engine).get(
        "/tts/announcement", params={"ticketNumber": "A-001", "counterId": 1}
    )
    assert response.status_code == 503


def test_an_engine_fault_is_500() -> None:
    engine = FakeEngine(fail_with=TtsEngineError("onnx exploded"))
    response = build_client(engine=engine).get(
        "/tts/announcement", params={"ticketNumber": "A-001", "counterId": 1}
    )
    assert response.status_code == 500


def test_an_unconfigured_engine_id_is_503() -> None:
    client = build_client(config=FakeConfig(engine="not-installed"))
    response = client.get(
        "/tts/announcement", params={"ticketNumber": "A-001", "counterId": 1}
    )
    assert response.status_code == 503


def test_probe_serves_a_silent_clip_for_the_autoplay_unlock() -> None:
    response = build_client().get("/tts/probe")
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.content == PROBE_BYTES


def test_probe_is_cacheable_since_it_never_changes() -> None:
    assert "max-age" in build_client().get("/tts/probe").headers["cache-control"]


def test_voices_lists_selectable_voices_for_the_admin_panel() -> None:
    response = build_client().get("/tts/voices")
    assert response.status_code == 200
    assert response.json()["voices"][0]["id"] == "fake-voice"


def test_preview_synthesizes_arbitrary_text() -> None:
    response = build_client().get("/tts/preview", params={"text": "tes suara"})
    assert response.status_code == 200
    assert response.headers["x-announcement-text"] == "tes suara"


def test_preview_rejects_empty_and_overlong_text() -> None:
    client = build_client()
    assert client.get("/tts/preview", params={"text": ""}).status_code == 422
    assert client.get("/tts/preview", params={"text": "x" * 500}).status_code == 422


def test_every_route_is_under_the_tts_prefix() -> None:
    """The prefix lives in the app, not in an nginx rewrite.

    core-api does the same (`@Controller('api/health')`), which is what lets the
    gateway `proxy_pass` without a trailing slash and the Vite dev proxy work with
    no rewrite -- so one URL behaves identically in dev and behind the gateway.
    Stripping the prefix in nginx instead would make dev and production diverge.
    """
    app = FastAPI()
    engine = FakeEngine()
    app.include_router(
        build_router(
            SynthesizeAnnouncementUseCase(
                engines={engine.id: engine},
                cache=FakeCache(),
                finisher=fake_finisher,
                config_provider=FakeConfigProvider(FakeConfig(engine=engine.id)),
            ),
            lambda: PROBE_BYTES,
        )
    )
    paths = {route.path for route in app.routes if hasattr(route, "path")}
    assert {p for p in paths if p.startswith("/tts")} == {
        "/tts/health",
        "/tts/voices",
        "/tts/announcement",
        "/tts/preview",
        "/tts/probe",
    }
