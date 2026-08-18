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

from ..domain.announcement import AnnouncementRequest, AnnouncementScript, build_script
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
        overrides: TtsSettings | None = None,
        pause_ms: int | None = None,
    ) -> Announcement:
        """Synthesize a sample for the admin panel's "Tes Suara" button.

        With no `text`, renders a real announcement built by the domain. That is
        deliberate: the admin panel is tuning how an ANNOUNCEMENT sounds, and if
        it had to supply the words it would have to know Indonesian queue
        phrasing -- the exact knowledge that was moved out of the consuming
        services and into this one.

        `overrides` and `pause_ms` let the panel audition unsaved values. Without
        them the manager would have to save a speed to find out whether they like
        it, which for a setting whose only acceptance test is "does it sound
        right" is the wrong way round. They are applied ON TOP of the resolved
        config, so anything not being auditioned still comes from the store's
        real configuration.
        """
        script = (
            AnnouncementScript(text=text, segments=(text,))
            if text is not None
            else build_script(SAMPLE_ANNOUNCEMENT)
        )
        return self._render(script, overrides=overrides, pause_ms=pause_ms)

    def current_settings(self) -> TtsSettings:
        """The stored delivery knobs, so an adapter can override one of them.

        Exposed rather than letting the adapter read the config provider itself:
        the resolved config is this layer's collaborator, and handing the HTTP
        layer a `TtsConfigProvider` would make the route responsible for knowing
        which parts of a config are engine settings.
        """
        return self._resolve_config().settings

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
        overrides: TtsSettings | None = None,
        pause_ms: int | None = None,
    ) -> Announcement:
        config = self._resolve_config()
        settings = overrides if overrides is not None else config.settings
        gap_ms = pause_ms if pause_ms is not None else config.pause_ms
        text = script.text

        # The auditioned values, not the stored ones, are what identify the clip
        # -- otherwise two previews at different speeds would collide on one key
        # and the second would be served the first one's audio.
        parts = (
            config.cache_parts
            if overrides is None and pause_ms is None
            else (config.engine, settings.voice_id, settings.speed, settings.volume, gap_ms)
        )
        key = self._cache_key(parts, text)

        cached = self._cache.get(key)
        if cached is not None:
            return Announcement(mp3=cached, cache_key=key, text=text, cached=True)

        engine = self._engine_for(config.engine)
        # One utterance unless a pause is actually wanted. Synthesizing segment by
        # segment costs one engine call per segment and gives each its own
        # intonation contour, so it is not something to do "just in case" -- with
        # `gap_ms` at 0 this is exactly the single call the pipeline always made.
        if gap_ms > 0 and len(script.segments) > 1:
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
