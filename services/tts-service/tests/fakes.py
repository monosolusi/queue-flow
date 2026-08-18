"""Test doubles for the outbound ports.

These exist so the application and HTTP layers can be exercised with neither Piper
(a 63 MB model) nor ffmpeg installed -- which is what lets `npm run verify` stay
green on any developer machine and on a fresh clone.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.domain.announcement import PauseDuration
from app.domain.tts_engine import TtsEngine, TtsSettings, Voice, VoiceNotAvailableError


class FakeEngine(TtsEngine):
    """Records what it was asked to say and returns deterministic pseudo-WAV bytes."""

    def __init__(
        self,
        engine_id: str = "fake",
        *,
        voices: tuple[Voice, ...] = (
            Voice(id="fake-voice", label="Fake", language="id-ID"),
        ),
        fail_with: Exception | None = None,
    ) -> None:
        self._id = engine_id
        self._voices = voices
        self._fail_with = fail_with
        self.calls: list[tuple[str, TtsSettings]] = []

    @property
    def id(self) -> str:
        return self._id

    def voices(self) -> list[Voice]:
        return list(self._voices)

    def synthesize(self, text: str, settings: TtsSettings) -> bytes:
        self.calls.append((text, settings))
        if self._fail_with is not None:
            raise self._fail_with
        return f"WAV::{self._id}::{settings.voice_id}::{text}".encode()


class FakeCache:
    """In-memory `AudioCachePort`, with counters so tests can assert hit/miss."""

    def __init__(self) -> None:
        self.entries: dict[str, bytes] = {}
        self.clears = 0

    def get(self, key: str) -> bytes | None:
        return self.entries.get(key)

    def put(self, key: str, payload: bytes) -> None:
        self.entries[key] = payload

    def clear(self) -> int:
        removed = len(self.entries)
        self.entries.clear()
        self.clears += 1
        return removed


def fake_finisher(speech_segments: list[bytes], gap_ms: int) -> bytes:
    """Stands in for the ffmpeg chain: marks the bytes as bell-prefixed and encoded.

    Renders the gap into the output so a test can tell a paused clip from an
    unpaused one without ffmpeg, and joins segments with a visible separator so
    the segmentation itself is assertable.
    """
    return b"MP3::BELL::" + f"GAP{gap_ms}::".encode() + b"|".join(speech_segments)


@dataclass
class FakeConfig:
    """Mirrors `TtsConfig`'s read surface."""

    engine: str = "fake"
    settings: TtsSettings = field(
        default_factory=lambda: TtsSettings(voice_id="fake-voice")
    )
    pause: PauseDuration = PauseDuration(0)


class FakeConfigProvider:
    """Serves a mutable config so tests can simulate an admin changing the voice."""

    def __init__(self, config: FakeConfig | None = None) -> None:
        self.config = config or FakeConfig()
        self.resolves = 0

    def resolve(self) -> FakeConfig:
        self.resolves += 1
        return self.config


__all__ = [
    "FakeCache",
    "FakeConfig",
    "FakeConfigProvider",
    "FakeEngine",
    "VoiceNotAvailableError",
    "fake_finisher",
]
