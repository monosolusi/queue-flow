"""The announcement use case: caching, engine selection, config changes."""

from __future__ import annotations

import pytest

from app.application.synthesize_announcement import (
    SynthesizeAnnouncementUseCase,
    UnknownTtsEngineError,
)
from app.domain.announcement import AnnouncementRequest
from app.domain.tts_engine import TtsSettings, Voice

from .fakes import (
    FakeCache,
    FakeConfig,
    FakeConfigProvider,
    FakeEngine,
    fake_finisher,
)


def build(
    *,
    engine: FakeEngine | None = None,
    cache: FakeCache | None = None,
    provider: FakeConfigProvider | None = None,
    extra_engines: dict | None = None,
):
    engine = engine or FakeEngine()
    engines = {engine.id: engine, **(extra_engines or {})}
    return (
        SynthesizeAnnouncementUseCase(
            engines=engines,
            cache=cache or FakeCache(),
            finisher=fake_finisher,
            config_provider=provider or FakeConfigProvider(),
        ),
        engine,
    )


def request(ticket_number: str = "A-005", counter_id: int = 2) -> AnnouncementRequest:
    return AnnouncementRequest(ticket_number=ticket_number, counter_id=counter_id)


def test_synthesizes_the_composed_indonesian_sentence() -> None:
    use_case, engine = build()
    result = use_case.execute(request())

    assert engine.calls[0][0] == "nomor antrian a lima, silakan ke loket dua"
    assert result.text == "nomor antrian a lima, silakan ke loket dua"


def test_passes_the_speech_through_the_finisher_so_the_bell_is_prepended() -> None:
    """The bell is not the engine's job -- every engine gets the same chime."""
    use_case, _ = build()
    assert use_case.execute(request()).mp3.startswith(b"MP3::BELL::")


def test_second_identical_announcement_is_served_from_cache() -> None:
    """"Panggil Ulang" must not pay for synthesis again."""
    use_case, engine = build()

    first = use_case.execute(request())
    second = use_case.execute(request())

    assert len(engine.calls) == 1
    assert first.cached is False
    assert second.cached is True
    assert second.mp3 == first.mp3


def test_a_different_ticket_is_a_cache_miss() -> None:
    use_case, engine = build()
    use_case.execute(request("A-005", 2))
    use_case.execute(request("A-006", 2))
    assert len(engine.calls) == 2


def test_the_etag_is_stable_for_the_same_announcement() -> None:
    use_case, _ = build()
    assert use_case.execute(request()).cache_key == use_case.execute(request()).cache_key


def test_changing_the_voice_changes_the_cache_key() -> None:
    """The classic cache bug: text unchanged, voice changed, stale audio served.

    The voice is part of the key, so the new voice cannot be masked by an entry
    synthesized with the old one.
    """
    provider = FakeConfigProvider()
    cache = FakeCache()
    use_case, engine = build(cache=cache, provider=provider)

    first = use_case.execute(request())
    provider.config = FakeConfig(settings=TtsSettings(voice_id="other-voice"))
    second = use_case.execute(request())

    assert second.cache_key != first.cache_key
    assert len(engine.calls) == 2
    assert engine.calls[1][1].voice_id == "other-voice"


def test_changing_config_clears_the_cache_so_it_cannot_grow_without_bound() -> None:
    provider = FakeConfigProvider()
    cache = FakeCache()
    use_case, _ = build(cache=cache, provider=provider)

    use_case.execute(request())
    provider.config = FakeConfig(settings=TtsSettings(voice_id="other-voice", speed=1.5))
    use_case.execute(request())

    assert cache.clears == 1


def test_unchanged_config_does_not_clear_the_cache() -> None:
    provider = FakeConfigProvider()
    cache = FakeCache()
    use_case, _ = build(cache=cache, provider=provider)

    use_case.execute(request())
    use_case.execute(request("A-006", 1))

    assert cache.clears == 0


def test_selects_the_engine_named_by_config() -> None:
    """The swappability guarantee, at the use-case level."""
    piper_like = FakeEngine("piper")
    recorded_like = FakeEngine("prerecorded")
    use_case = SynthesizeAnnouncementUseCase(
        engines={"piper": piper_like, "prerecorded": recorded_like},
        cache=FakeCache(),
        finisher=fake_finisher,
        config_provider=FakeConfigProvider(FakeConfig(engine="prerecorded")),
    )

    use_case.execute(request())

    assert recorded_like.calls and not piper_like.calls


def test_rejects_an_engine_id_that_is_not_configured() -> None:
    use_case, _ = build(provider=FakeConfigProvider(FakeConfig(engine="nope")))
    with pytest.raises(UnknownTtsEngineError, match="nope"):
        use_case.execute(request())


def test_an_unconfigured_engine_is_not_signalled_with_a_bare_KeyError() -> None:
    """The adapter maps this to 503 "fix your config".

    If a builtin `KeyError` carried that meaning, any unrelated KeyError raised
    deeper down -- e.g. a changed ffmpeg JSON key -- would reach the operator as a
    configuration problem instead of the server fault it is.
    """
    use_case, _ = build(provider=FakeConfigProvider(FakeConfig(engine="nope")))
    with pytest.raises(UnknownTtsEngineError) as caught:
        use_case.execute(request())

    assert not isinstance(caught.value, KeyError)


def test_preview_synthesizes_arbitrary_text_for_the_admin_test_button() -> None:
    use_case, engine = build()
    result = use_case.preview("halo, ini tes suara")
    assert engine.calls[0][0] == "halo, ini tes suara"
    assert result.mp3.startswith(b"MP3::BELL::")


def test_lists_every_engines_voices_for_the_admin_dropdown() -> None:
    use_case = SynthesizeAnnouncementUseCase(
        engines={"piper": FakeEngine("piper"), "prerecorded": FakeEngine("prerecorded")},
        cache=FakeCache(),
        finisher=fake_finisher,
        config_provider=FakeConfigProvider(),
    )
    voices = use_case.available_voices()
    assert {entry.engine for entry in voices} == {"piper", "prerecorded"}
    assert all(
        entry.voice.id and entry.voice.label and entry.voice.language
        for entry in voices
    )
    # Domain objects, not pre-flattened JSON: serializing is the adapter's job, so a
    # change to the wire shape must not reach back into this layer.
    assert all(isinstance(entry.voice, Voice) for entry in voices)


def test_a_failing_engine_does_not_poison_the_cache() -> None:
    """A failed synthesis must leave nothing behind that a later hit would serve."""
    cache = FakeCache()
    use_case, _ = build(engine=FakeEngine(fail_with=RuntimeError("boom")), cache=cache)

    with pytest.raises(RuntimeError):
        use_case.execute(request())

    assert cache.entries == {}
