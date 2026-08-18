"""The announcement use case: caching, engine selection, config changes."""

from __future__ import annotations

import pytest

from app.application.synthesize_announcement import (
    SynthesizeAnnouncementUseCase,
    UnknownTtsEngineError,
)
from app.domain.announcement import AnnouncementRequest, PauseDuration
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


# ---------------------------------------------------------------------------
# Pause: segmentation and the gap. The feature manifests as MORE engine calls
# and a gap handed to the finisher, so those are what these assert -- the audio
# itself is measured in test_audio_pipeline_integration.py, which has ffmpeg.
# ---------------------------------------------------------------------------


def test_no_pause_synthesizes_the_whole_sentence_in_one_call() -> None:
    """The default must not merely sound like the old pipeline -- it must BE it.

    One engine call with the full sentence, which is what gives Piper the whole
    line to find an intonation contour for.
    """
    use_case, engine = build(provider=FakeConfigProvider(FakeConfig(pause=PauseDuration(0))))

    result = use_case.execute(AnnouncementRequest(ticket_number="A-005", counter_id=2))

    assert len(engine.calls) == 1
    assert engine.calls[0][0] == "nomor antrian a lima, silakan ke loket dua"
    assert b"GAP0::" in result.mp3


def test_a_configured_pause_synthesizes_each_segment_and_passes_the_gap_on() -> None:
    use_case, engine = build(provider=FakeConfigProvider(FakeConfig(pause=PauseDuration(400))))

    result = use_case.execute(AnnouncementRequest(ticket_number="A-005", counter_id=2))

    spoken = [text for text, _ in engine.calls]
    assert spoken == ["nomor antrian,", "a lima,", "silakan ke loket,", "dua"]
    assert b"GAP400::" in result.mp3


def test_non_final_segments_carry_a_continuing_comma_and_the_last_does_not() -> None:
    """A trailing comma is what keeps a segment from sounding like a finished
    sentence; on the LAST one it would ask for a mid-thought ending instead."""
    use_case, engine = build(provider=FakeConfigProvider(FakeConfig(pause=PauseDuration(250))))

    use_case.execute(AnnouncementRequest(ticket_number="A-001", counter_id=1))

    spoken = [text for text, _ in engine.calls]
    assert all(part.endswith(",") for part in spoken[:-1])
    assert not spoken[-1].endswith(",")


def test_the_text_reported_is_the_whole_sentence_even_when_segmented() -> None:
    """`X-Announcement-Text` answers "why did the board say that?" -- a list of
    fragments would answer a different question."""
    use_case, _ = build(provider=FakeConfigProvider(FakeConfig(pause=PauseDuration(400))))

    result = use_case.execute(AnnouncementRequest(ticket_number="A-005", counter_id=2))

    assert result.text == "nomor antrian a lima, silakan ke loket dua"


def test_changing_only_the_pause_produces_a_different_clip() -> None:
    """The classic cache bug: same words, changed knob, stale audio served. The
    pause has to be in the digest or a manager's change is invisible."""
    cache = FakeCache()
    provider = FakeConfigProvider(FakeConfig(pause=PauseDuration(0)))
    use_case, _ = build(cache=cache, provider=provider)
    request = AnnouncementRequest(ticket_number="A-005", counter_id=2)

    first = use_case.execute(request)
    provider.config = FakeConfig(pause=PauseDuration(400))
    second = use_case.execute(request)

    assert first.cache_key != second.cache_key
    assert second.cached is False
    assert first.mp3 != second.mp3


def test_a_pause_on_a_single_segment_script_stays_one_call() -> None:
    """A preview of free-form text has no seams; a configured pause must not make
    the use case invent one by splitting on nothing."""
    use_case, engine = build(provider=FakeConfigProvider(FakeConfig(pause=PauseDuration(400))))

    use_case.preview("halo semua")

    assert len(engine.calls) == 1
    assert engine.calls[0][0] == "halo semua"


def test_preview_without_text_announces_a_real_sample_ticket() -> None:
    """The admin panel must not have to know Indonesian queue phrasing to test
    the voice -- that knowledge is this service's whole reason for existing."""
    use_case, engine = build()

    result = use_case.preview()

    assert result.text == "nomor antrian a satu, silakan ke loket satu"
    assert engine.calls[0][0] == result.text


def test_preview_overrides_audition_unsaved_knobs_without_touching_the_voice() -> None:
    stored = FakeConfig(settings=TtsSettings(voice_id="fake-voice", speed=1.0, volume=1.0))
    use_case, engine = build(provider=FakeConfigProvider(stored))

    use_case.preview("halo", speed=0.8)

    _, used = engine.calls[0]
    assert used.speed == 0.8
    # The voice is NOT part of what is being auditioned, so it must still be the
    # store's own — a preview of the wrong voice tests nothing.
    assert used.voice_id == "fake-voice"


def test_two_previews_at_different_speeds_do_not_collide_in_the_cache() -> None:
    """Overrides bypass the stored config, so they have to reach the digest by a
    different path than `cache_parts` — this is what pins that they do."""
    cache = FakeCache()
    use_case, _ = build(cache=cache)

    slow = use_case.preview("halo", speed=0.6)
    fast = use_case.preview("halo", speed=1.4)

    assert slow.cache_key != fast.cache_key
    assert fast.cached is False


def test_a_pause_separates_cache_entries_only_where_it_can_change_the_audio() -> None:
    """A gap with no seam to sit in is not part of the clip's identity.

    Free-form preview text is a single segment, so there is nowhere for silence
    to go and the two clips are byte-identical -- giving them separate keys would
    buy two cache slots and two full ffmpeg chains for the same audio. A real
    announcement has seams, so there the pause does change the key."""
    use_case, _ = build(cache=FakeCache())

    flat = use_case.preview("halo dunia", pause_ms=0)
    still_flat = use_case.preview("halo dunia", pause_ms=500)
    assert flat.cache_key == still_flat.cache_key
    assert still_flat.cached is True
    assert flat.mp3 == still_flat.mp3

    use_case, _ = build(cache=FakeCache())
    joined = use_case.preview(pause_ms=0)
    spaced = use_case.preview(pause_ms=500)
    assert joined.cache_key != spaced.cache_key
