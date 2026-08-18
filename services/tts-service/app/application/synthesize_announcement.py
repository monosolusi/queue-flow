"""Use case: turn a called ticket into playable announcement audio.

Depends only on ports -- the `TtsEngine` abstraction plus the cache, finisher and
config provider protocols from `domain/ports.py`. It has no idea Piper or ffmpeg
exist, which is what lets the engine be swapped from the admin panel without
touching this layer, and lets these paths be tested with neither installed.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass

from ..domain.announcement import (
    AnnouncementRequest,
    AnnouncementScript,
    PauseDuration,
    build_script,
)
from ..domain.ports import AudioCachePort, AudioFinisher, TtsConfigProvider
from ..domain.tts_engine import TtsEngine, TtsSettings, Voice

logger = logging.getLogger(__name__)

# Bumped whenever the finishing chain or the bell changes. It is folded into the
# cache key so a pipeline change invalidates old clips instead of serving audio
# built by the previous version forever.
#
# 2: the finisher gained segment joining. A clip rendered with no pause is
# unchanged by that, but the version is bumped anyway -- a cache full of clips
# built by an older chain is not worth the risk of reasoning about which of them
# happen to still be byte-identical.
#
# Also bump it when the SEAMS move. The key digests the sentence, not its
# segmentation, because segmentation is a pure function of the sentence -- so
# re-cutting `build_script`'s segments changes what a paused announcement sounds
# like without changing a single key.
PIPELINE_VERSION = 2

_KEY_SEPARATOR = "\x1f"

#: The ticket the "Tes Suara" button announces. A real-shaped ticket number and
#: counter so the manager hears the actual sentence -- including the numbers,
#: which are the parts a pause is being tuned for.
SAMPLE_ANNOUNCEMENT = AnnouncementRequest(ticket_number="A-001", counter_id=1)


class UnknownTtsEngineError(RuntimeError):
    """The configured engine id matches none of the engines that were wired up.

    Its own type rather than a bare `KeyError`: the adapter maps this to 503 "fix
    your config", and a builtin would let an unrelated `KeyError` escaping from
    anywhere below be reported to the operator as a configuration problem.
    """


@dataclass(frozen=True)
class Announcement:
    """Finished audio plus the identity of the inputs that produced it."""

    mp3: bytes
    #: Digest of every input that can change the audio. The HTTP layer happens to
    #: serve it as an `ETag`, but this layer does not know that -- naming it `etag`
    #: would put an HTTP header in a use-case DTO.
    cache_key: str
    text: str
    cached: bool


@dataclass(frozen=True)
class EngineVoice:
    """A voice together with the engine that offers it.

    The pairing is the use case's contribution; how it reaches a dropdown is the
    adapter's. Returning pre-flattened JSON dicts from here would mean a wire-shape
    change forced an edit to this layer.
    """

    engine: str
    voice: Voice


class SynthesizeAnnouncementUseCase:
    def __init__(
        self,
        *,
        engines: dict[str, TtsEngine],
        cache: AudioCachePort,
        finisher: AudioFinisher,
        config_provider: TtsConfigProvider,
    ) -> None:
        self._engines = engines
        self._cache = cache
        self._finish = finisher
        self._config_provider = config_provider
        self._last_config: object | None = None

    def execute(self, request: AnnouncementRequest) -> Announcement:
        """Render the announcement for a called ticket."""
        return self._render(build_script(request))

    def preview(
        self,
        text: str | None = None,
        *,
        speed: float | None = None,
        volume: float | None = None,
        pause_ms: int | None = None,
    ) -> Announcement:
        """Synthesize a sample for the admin panel's "Tes Suara" button.

        With no `text`, renders a real announcement built by the domain. That is
        deliberate: the admin panel is tuning how an ANNOUNCEMENT sounds, and if
        it had to supply the words it would have to know Indonesian queue
        phrasing -- the exact knowledge that was moved out of the consuming
        services and into this one.

        Each knob is an independent optional so the panel can audition unsaved
        values. Without that the manager would have to save a speed to find out
        whether they like it, which for a setting whose only acceptance test is
        "does it sound right" is the wrong way round.

        They are SCALARS, not a pre-merged `TtsSettings`, on purpose: merging one
        auditioned knob over the stored configuration -- and knowing that an
        omitted knob means "keep the store's", and that the voice is never
        auditioned -- is this layer's policy. Handing an adapter the job of
        assembling a settings object made it decide all three.

        The multipliers are QUANTIZED to `_AUDITION_DECIMALS`. Every distinct
        value is a full synthesis into a bounded FIFO cache, so continuous floats
        would let `speed=1.0000001` evict the store's hot clips one request at a
        time -- and `/tts/preview` is unauthenticated. It happens HERE rather than
        at the route because it is a statement about what identifies a clip, and
        that is this layer's policy; a second adapter calling `preview()` would
        otherwise reopen the hole. Two decimals is finer than the admin slider's
        own 0.05 step, so nothing a manager can select is lost.

        Only the AUDITIONED values are rounded. A stored speed comes from
        core-api's value object, and quietly altering a configured value on its
        way to the engine would make the board sound like something nobody chose.
        """
        speed = _quantize(speed)
        volume = _quantize(volume)
        script = (
            AnnouncementScript(text=text, segments=(text,))
            if text is not None
            else build_script(SAMPLE_ANNOUNCEMENT)
        )
        return self._render(script, speed=speed, volume=volume, pause_ms=pause_ms)

    def available_voices(self) -> list[EngineVoice]:
        """Every engine's voices, paired with the engine that offers them."""
        return [
            EngineVoice(engine=engine_id, voice=voice)
            for engine_id, engine in self._engines.items()
            for voice in engine.voices()
        ]

    def _render(
        self,
        script: AnnouncementScript,
        *,
        speed: float | None = None,
        volume: float | None = None,
        pause_ms: int | None = None,
    ) -> Announcement:
        # Resolved exactly once. `_resolve_config` MUTATES (it clears the cache
        # when the configuration changed), so calling it a second time from a
        # read path would put a compare-and-set on every request -- two
        # concurrent previews could interleave it and wipe the announcement
        # cache for no reason.
        config = self._resolve_config()
        stored = config.settings
        # An omitted knob keeps the store's value; the voice is never auditioned,
        # so a preview always tests the voice the board actually uses.
        settings = TtsSettings(
            voice_id=stored.voice_id,
            speed=stored.speed if speed is None else speed,
            volume=stored.volume if volume is None else volume,
        )
        pause = config.pause if pause_ms is None else PauseDuration(pause_ms)
        text = script.text

        # A gap with no seam to sit in cannot change the audio, so it must not
        # change the identity either -- free-form preview text is a single
        # segment, and two pause values there would occupy two cache slots for
        # byte-identical clips and pay for two full ffmpeg chains.
        gap_ms = pause.milliseconds if len(script.segments) > 1 else 0
        # Built here, in one place, from the values actually used. An earlier
        # revision let the config expose a ready-made tuple and hand-rolled a
        # second one for the override path; they agreed only by coincidence, and
        # a knob added to one would have silently collided in the other.
        key = self._cache_key(
            (config.engine, settings.voice_id, settings.speed, settings.volume, gap_ms),
            text,
        )

        cached = self._cache.get(key)
        if cached is not None:
            return Announcement(mp3=cached, cache_key=key, text=text, cached=True)

        engine = self._engine_for(config.engine)
        # One utterance unless a pause is actually wanted. Synthesizing segment by
        # segment costs one engine call per segment and gives each its own
        # intonation contour, so it is not something to do "just in case" -- with
        # `gap_ms` at 0 this is exactly the single call the pipeline always made.
        #
        # Measured with the real voice on "nomor antrian a satu, silakan ke loket
        # satu": each seam adds exactly `gap_ms` (3 seams x 200 ms = +0.60 s), but
        # crossing from 0 to any pause at all also costs a fixed ~0.4 s, because
        # per-utterance synthesis leaves a little lead-in and tail on each piece
        # that sits above the trim's -50 dB floor. That is inherent to cutting the
        # sentence up, not a leak -- lowering the floor to reclaim it would start
        # eating quiet consonants.
        if gap_ms > 0:
            speech = [
                engine.synthesize(part, settings)
                for part in _continuing(script.segments)
            ]
        else:
            speech = [engine.synthesize(text, settings)]
        mp3 = self._finish(speech, gap_ms)
        self._cache.put(key, mp3)
        return Announcement(mp3=mp3, cache_key=key, text=text, cached=False)

    @staticmethod
    def _cache_key(config_parts: tuple[object, ...], text: str) -> str:
        """Digest every input that can change the audio.

        The engine, voice and delivery knobs are all in the key, not just the text.
        Omitting any of them is the classic cache bug: an admin switches voice, the
        text is unchanged, and the store keeps hearing the old voice with no way to
        tell why.
        """
        payload = _KEY_SEPARATOR.join(
            str(part) for part in (PIPELINE_VERSION, *config_parts, text)
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _resolve_config(self):
        """Read config, dropping cached audio when the announcement settings change.

        The settings are already part of the cache key, so this clear is not needed
        for correctness -- it stops the cache growing without bound as a manager
        tries voices and speeds from the admin panel.
        """
        config = self._config_provider.resolve()
        if self._last_config is not None and config != self._last_config:
            removed = self._cache.clear()
            logger.info("tts config changed; cleared %d cached clips", removed)
        self._last_config = config
        return config

    def _engine_for(self, engine_id: str) -> TtsEngine:
        engine = self._engines.get(engine_id)
        if engine is None:
            known = ", ".join(sorted(self._engines)) or "none"
            raise UnknownTtsEngineError(
                f"unknown TTS engine {engine_id!r}; configured engines: {known}"
            )
        return engine



def _continuing(segments: tuple[str, ...]) -> list[str]:
    """Mark every segment but the last as mid-sentence, with a trailing comma.

    Synthesized on its own, "nomor antrian" is a complete utterance and the voice
    gives it a falling, finished intonation -- four of those in a row sound like
    four announcements, not one. A trailing comma is what tells the phonemizer
    the thought continues, and it is the same punctuation the un-segmented
    sentence already relies on.

    The pause the comma itself introduces is not wanted here and does not
    survive: the finisher trims each segment's leading and trailing silence
    before inserting the configured gap, so the gap is the configured length
    rather than the configured length plus whatever the voice felt like.

    Engines that ignore punctuation are unaffected -- `PrerecordedTtsEngine`
    tokenizes with a letters-only pattern, so the comma is invisible to it while
    the pause, which the finisher produces, still works.
    """
    return [f"{part}," for part in segments[:-1]] + [segments[-1]]


#: Decimal places the auditioned multipliers are rounded to. Bounds the key space
#: of an unauthenticated route; see `SynthesizeAnnouncementUseCase.preview`.
_AUDITION_DECIMALS = 2


def _quantize(value: float | None) -> float | None:
    """Round an auditioned multiplier, preserving "not auditioned" as None."""
    return None if value is None else round(value, _AUDITION_DECIMALS)
