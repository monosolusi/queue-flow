"""Reading `ttsConfiguration` from core-api, and surviving its absence."""

from __future__ import annotations

import json

import pytest

from app.infrastructure.core_api_config_client import (
    DEFAULT_ENGINE,
    DEFAULT_VOICE,
    CoreApiConfigClient,
)


def parse(body: object):
    return CoreApiConfigClient._parse(body)


def test_reads_engine_and_voice_from_the_config_document() -> None:
    config = parse(
        {"ttsConfiguration": {"engine": "prerecorded", "voice": "bu-sari", "speed": 1.2}}
    )
    assert config.engine == "prerecorded"
    assert config.settings.voice_id == "bu-sari"
    assert config.settings.speed == pytest.approx(1.2)


def test_defaults_when_ttsconfiguration_is_absent() -> None:
    """The normal case until the admin-panel change lands.

    This service ships BEFORE `ttsConfiguration` exists in core-api, and stores
    configured by an older wizard will never have it. An absent key must yield a
    fully working configuration, not a placeholder that fails on first use.
    """
    config = parse({"storeName": "Toko Utama"})
    assert config.engine == DEFAULT_ENGINE
    assert config.settings.voice_id == DEFAULT_VOICE
    assert config.settings.speed == 1.0
    assert config.settings.volume == 1.0


@pytest.mark.parametrize("body", [None, [], "nope", 42, {"ttsConfiguration": "nope"}])
def test_defaults_when_the_document_is_not_the_expected_shape(body: object) -> None:
    assert parse(body).engine == DEFAULT_ENGINE


def test_defaults_each_field_independently() -> None:
    """A partial object is normal -- an older config may carry only some keys."""
    config = parse({"ttsConfiguration": {"voice": "bu-sari"}})
    assert config.engine == DEFAULT_ENGINE
    assert config.settings.voice_id == "bu-sari"


@pytest.mark.parametrize(
    "knobs",
    [
        {"speed": 0},  # below the allowed range
        {"speed": 99},
        {"volume": -1},
        {"speed": "cepat"},
        {"volume": True},
    ],
)
def test_out_of_range_knobs_fall_back_instead_of_going_mute(knobs: dict) -> None:
    """A misconfigured speed is not a reason for the board to stop speaking."""
    config = parse({"ttsConfiguration": {"voice": "v", **knobs}})
    assert config.settings.speed > 0
    assert config.settings.volume >= 0


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_blank_strings_are_treated_as_absent(blank: str) -> None:
    """A voice id of "   " is not a voice.

    Accepting it would defer a guaranteed VoiceNotAvailableError to the first
    announcement, where it reads as a broken service rather than a config typo.
    """
    config = parse({"ttsConfiguration": {"engine": blank, "voice": blank}})
    assert config.engine == DEFAULT_ENGINE
    assert config.settings.voice_id == DEFAULT_VOICE


def test_surrounding_whitespace_is_trimmed_not_passed_through() -> None:
    config = parse({"ttsConfiguration": {"engine": " piper ", "voice": " bu-sari "}})
    assert config.engine == "piper"
    assert config.settings.voice_id == "bu-sari"


class _StubResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = json.dumps(payload).encode()

    def read(self) -> bytes:
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        return None


def test_caches_within_the_ttl_so_every_announcement_is_not_a_round_trip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_urlopen(url, timeout=None):  # noqa: ANN001, ARG001
        calls.append(url)
        return _StubResponse({"ttsConfiguration": {"voice": "v1"}})

    monkeypatch.setattr(
        "app.infrastructure.core_api_config_client.urllib.request.urlopen", fake_urlopen
    )
    client = CoreApiConfigClient("http://core-api:3000", ttl_seconds=300)

    client.resolve()
    client.resolve()
    client.resolve()

    assert len(calls) == 1
    assert calls[0] == "http://core-api:3000/api/system/config"


def test_an_unreachable_core_api_does_not_silence_the_board(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """core-api restarting must not make the TV mute -- fall back and keep going."""

    def boom(url, timeout=None):  # noqa: ANN001, ARG001
        raise OSError("connection refused")

    monkeypatch.setattr(
        "app.infrastructure.core_api_config_client.urllib.request.urlopen", boom
    )
    config = CoreApiConfigClient("http://core-api:3000").resolve()
    assert config.engine == DEFAULT_ENGINE
    assert config.settings.voice_id == DEFAULT_VOICE


def test_a_failed_first_fetch_retries_rather_than_caching_the_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Otherwise a single blip at boot would pin defaults for the whole TTL.

    The store would keep the wrong voice for 30 s after core-api came back, with
    nothing in the logs to explain it.
    """
    attempts: list[int] = []

    def flaky(url, timeout=None):  # noqa: ANN001, ARG001
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("not up yet")
        return _StubResponse({"ttsConfiguration": {"voice": "bu-sari"}})

    monkeypatch.setattr(
        "app.infrastructure.core_api_config_client.urllib.request.urlopen", flaky
    )
    client = CoreApiConfigClient("http://core-api:3000", ttl_seconds=300)

    assert client.resolve().settings.voice_id == DEFAULT_VOICE
    assert client.resolve().settings.voice_id == "bu-sari"
    assert len(attempts) == 2


def test_malformed_json_is_treated_as_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Garbage:
        def read(self) -> bytes:
            return b"<html>not json</html>"

        def __enter__(self):
            return self

        def __exit__(self, *_exc) -> None:
            return None

    monkeypatch.setattr(
        "app.infrastructure.core_api_config_client.urllib.request.urlopen",
        lambda url, timeout=None: Garbage(),  # noqa: ARG005
    )
    assert CoreApiConfigClient("http://core-api:3000").resolve().engine == DEFAULT_ENGINE


# ---------------------------------------------------------------------------
# pauseMs. Unlike speed/volume there is no `TtsSettings` downstream to own the
# range, so this parser is the only place a bad pause can be caught -- and it
# must catch it by falling back, never by raising, because a misconfigured pause
# must not be able to silence the board.
# ---------------------------------------------------------------------------


def test_reads_the_pause_from_the_config_document() -> None:
    config = parse({"ttsConfiguration": {"voice": "v", "pauseMs": 400}})
    assert config.pause_ms == 400


def test_defaults_the_pause_to_zero_when_absent() -> None:
    """A store configured by an older wizard carries no pauseMs at all, and zero
    is the delivery it already has -- so an upgrade changes nothing audible."""
    assert parse({"ttsConfiguration": {"voice": "v"}}).pause_ms == 0
    assert parse({}).pause_ms == 0


@pytest.mark.parametrize("value", ["400", None, [], {}, True, False, 250.5])
def test_a_non_integer_pause_falls_back(value: object) -> None:
    """`True` is an `int` in Python and would otherwise become a 1 ms pause."""
    config = parse({"ttsConfiguration": {"voice": "v", "pauseMs": value}})
    assert config.pause_ms == 0


@pytest.mark.parametrize("value", [-1, -400, 2001, 10_000])
def test_an_out_of_range_pause_falls_back(value: int) -> None:
    config = parse({"ttsConfiguration": {"voice": "v", "pauseMs": value}})
    assert config.pause_ms == 0


def test_an_integral_float_pause_is_accepted() -> None:
    """`400.0` is unambiguously 400 ms; rejecting it would silently restore the
    old delivery for a value that is not actually wrong."""
    assert parse({"ttsConfiguration": {"voice": "v", "pauseMs": 400.0}}).pause_ms == 400


def test_a_bad_pause_does_not_discard_the_other_knobs() -> None:
    """Speed and volume share a fallback (TtsSettings validates them as a set),
    but the pause is read independently -- a bad pause must not cost the manager
    their speed setting too."""
    config = parse(
        {"ttsConfiguration": {"voice": "bu-sari", "speed": 1.4, "pauseMs": -5}}
    )
    assert config.pause_ms == 0
    assert config.settings.speed == 1.4
    assert config.settings.voice_id == "bu-sari"


def test_the_pause_is_part_of_the_cache_identity() -> None:
    """A knob missing from `cache_parts` means a manager changes it and the store
    keeps hearing the old clip, with nothing to explain why."""
    a = parse({"ttsConfiguration": {"voice": "v", "pauseMs": 0}})
    b = parse({"ttsConfiguration": {"voice": "v", "pauseMs": 400}})
    assert a.cache_parts != b.cache_parts
