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


#: Engine-neutral multiplier bounds. Exported so the HTTP edge can bound a query
#: parameter with the SAME numbers `__post_init__` enforces, instead of restating
#: them as literals in a route signature.
MIN_SPEED = 0.25
MAX_SPEED = 4.0
MIN_VOLUME = 0.0
MAX_VOLUME = 2.0


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
        if not MIN_SPEED <= self.speed <= MAX_SPEED:
            raise ValueError(
                f"speed must be within [{MIN_SPEED}, {MAX_SPEED}], got {self.speed}"
            )
        if not MIN_VOLUME <= self.volume <= MAX_VOLUME:
            raise ValueError(
                f"volume must be within [{MIN_VOLUME}, {MAX_VOLUME}], got {self.volume}"
            )


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
