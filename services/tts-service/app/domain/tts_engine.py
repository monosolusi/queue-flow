"""The `TtsEngine` port -- the OCP seam that makes the model swappable.

This is the whole reason announcement audio lives in its own service. The TV board
depends on an HTTP contract (`GET /tts/announcement`), and this service depends on
this abstraction; neither depends on Piper. Swapping the engine changes what the
store hears without touching a line of `tv-display-service`.

The contract is deliberately SENTENCE-level, not word-level. A word-level port
would force every future engine to be a concatenator and would have kept Indonesian
grammar in the caller. Sentence-level lets a neural engine synthesize the whole
line with natural prosody while still allowing a concatenating implementation
(`PrerecordedTtsEngine`) to satisfy the same interface.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


class TtsEngineError(RuntimeError):
    """Synthesis failed for a reason the caller cannot fix by retrying."""


class VoiceNotAvailableError(TtsEngineError):
    """The requested voice is not one this engine provides."""


@dataclass(frozen=True)
class Voice:
    """A selectable voice, as offered to the admin panel's dropdown."""

    id: str
    label: str
    language: str


@dataclass(frozen=True)
class TtsSettings:
    """Per-request delivery knobs, mirroring `TtsConfiguration` in core-api.

    `speed` and `volume` are engine-neutral multipliers where 1.0 means "as the
    voice was recorded". Piper maps them onto `SynthesisConfig.length_scale` and
    `.volume`; a prerecorded engine may only honour `volume`. An engine MUST NOT
    fail on a knob it cannot implement -- degrading is correct, because the knob is
    a preference, not a precondition.
    """

    voice_id: str
    speed: float = 1.0
    volume: float = 1.0

    def __post_init__(self) -> None:
        if not 0.25 <= self.speed <= 4.0:
            raise ValueError(f"speed must be within [0.25, 4.0], got {self.speed}")
        if not 0.0 <= self.volume <= 2.0:
            raise ValueError(f"volume must be within [0.0, 2.0], got {self.volume}")


#: Bounds for the silence inserted at each seam of an announcement,
#: milliseconds. They live in the domain for the same reason the speed and
#: volume ranges do: the pause is a delivery invariant, and an invariant with no
#: owner gets restated by every adapter that happens to touch it -- which is how
#: a negative gap reaches ffmpeg as `apad=pad_dur=-0.5` and 500s.
#:
#: `0` means "read the announcement as one continuous utterance". The ceiling is
#: a usability guard rather than an engine limit: the sentence has three seams,
#: so 2000 ms already adds six seconds of silence.
MIN_PAUSE_MS = 0
MAX_PAUSE_MS = 2000


@dataclass(frozen=True)
class PauseDuration:
    """How long to hold each seam of an announcement.

    A type rather than a bare `int` so the range is checked once, wherever the
    value enters the domain, instead of once per entry point. Deliberately NOT a
    field of `TtsSettings`: no engine renders this silence (`PiperTtsEngine` maps
    only speed and volume, and `PrerecordedTtsEngine` honours neither), so
    putting it there would hand every engine a knob every engine ignores. It is
    decided when the finished clip is assembled.
    """

    milliseconds: int = MIN_PAUSE_MS

    def __post_init__(self) -> None:
        # `bool` is an `int` in Python, and `True` is not a duration.
        if isinstance(self.milliseconds, bool) or not isinstance(self.milliseconds, int):
            raise ValueError(
                f"pause must be a whole number of milliseconds, got {self.milliseconds!r}"
            )
        if not MIN_PAUSE_MS <= self.milliseconds <= MAX_PAUSE_MS:
            raise ValueError(
                f"pause must be within [{MIN_PAUSE_MS}, {MAX_PAUSE_MS}] ms, "
                f"got {self.milliseconds}"
            )

    @property
    def is_silent_seam(self) -> bool:
        """True when a seam actually holds -- i.e. the sentence gets segmented."""
        return self.milliseconds > MIN_PAUSE_MS


class TtsEngine(ABC):
    """Turns Indonesian text into WAV bytes."""

    @property
    @abstractmethod
    def id(self) -> str:
        """Stable engine identifier, used in the cache key and the admin dropdown."""

    @abstractmethod
    def voices(self) -> list[Voice]:
        """Voices this engine can render, for the admin panel."""

    @abstractmethod
    def synthesize(self, text: str, settings: TtsSettings) -> bytes:
        """Render `text` to a complete RIFF/WAVE byte string.

        Implementations return WAV rather than MP3 so the shared post-processing
        chain (loudness normalisation, silence trim, bell prepend, MP3 encode) is
        written once instead of once per engine.
        """
