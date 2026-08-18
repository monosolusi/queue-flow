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

from ..domain.announcement import AnnouncementRequest, build_script
from ..domain.ports import AudioCachePort, AudioFinisher, TtsConfigProvider
from ..domain.tts_engine import TtsEngine, Voice

logger = logging.getLogger(__name__)

# Bumped whenever the finishing chain or the bell changes. It is folded into the
# cache key so a pipeline change invalidates old clips instead of serving audio
# built by the previous version forever.
PIPELINE_VERSION = 1

_KEY_SEPARATOR = "\x1f"


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
        script = build_script(request)
        return self._render(script.text)

    def preview(self, text: str) -> Announcement:
        """Synthesize arbitrary text for the admin panel's "Tes Suara" button."""
        return self._render(text)

    def available_voices(self) -> list[EngineVoice]:
        """Every engine's voices, paired with the engine that offers them."""
        return [
            EngineVoice(engine=engine_id, voice=voice)
            for engine_id, engine in self._engines.items()
            for voice in engine.voices()
        ]

    def _render(self, text: str) -> Announcement:
        config = self._resolve_config()
        key = self._cache_key(config.cache_parts, text)

        cached = self._cache.get(key)
        if cached is not None:
            return Announcement(mp3=cached, cache_key=key, text=text, cached=True)

        engine = self._engine_for(config.engine)
        speech_wav = engine.synthesize(text, config.settings)
        mp3 = self._finish(speech_wav)
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
