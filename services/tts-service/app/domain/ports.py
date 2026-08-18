"""Outbound ports the application layer depends on.

Structural `Protocol`s rather than ABCs: the concrete classes in `infrastructure/`
satisfy them without importing this module, so the dependency arrow points inward
only (DIP). Mirrors how core-api defines repository interfaces in its domain layer
and keeps implementations in infrastructure.

Everything here is IO-free by construction -- these are the *shapes* of IO, not IO.
"""

from __future__ import annotations

from typing import Protocol

from .tts_engine import PauseDuration, TtsSettings


class AudioFinishingError(RuntimeError):
    """Finishing the clip failed (bell, loudness or encode).

    Declared beside the port rather than in infrastructure so the layers that catch
    it -- the use case and the HTTP adapter -- can name the failure without
    importing ffmpeg. The concrete implementation raises a subclass.
    """


class AudioCachePort(Protocol):
    """Byte store for finished announcement clips, addressed by an opaque key.

    Deliberately has no `key()` method: deciding what identifies an announcement is
    application policy (it must fold in the engine, voice, delivery knobs and
    pipeline version), while the store only has to persist bytes. Putting key
    derivation in the store would hide that policy in infrastructure.
    """

    def get(self, key: str) -> bytes | None: ...

    def put(self, key: str, payload: bytes) -> None: ...

    def clear(self) -> int: ...


class AudioFinisher(Protocol):
    """Turns raw speech WAV into the final playable clip (bell, loudness, encode).

    A port, not a direct import, for two reasons: the application layer must not
    depend on ffmpeg, and it lets the use case be tested without ffmpeg installed.

    Takes a LIST of speech parts and the silence to put between them, rather than
    one blob. Splitting the sentence is the domain's job and choosing the gap is
    config, but *rendering* silence is an audio operation, so it belongs on the
    side of this port that already owns the audio tools. The alternative -- a
    second `AudioJoiner` port -- would have meant two collaborators that can only
    ever be used together, and the joining is a concat, which this implementation
    already does to attach the bell.

    A single-element list must produce exactly what the un-segmented pipeline
    produced, so the no-pause default stays unchanged.

    `list[bytes]` rather than `collections.abc.Sequence[bytes]`: the architecture
    gate allowlists pure stdlib per layer by module name, and `collections.abc`
    is not `collections`.
    """

    def __call__(self, speech_segments: list[bytes], gap_ms: int) -> bytes:
        """Raises `AudioFinishingError` (or a subclass) when the chain fails."""
        ...


class TtsConfigProvider(Protocol):
    """Supplies the currently configured engine and delivery settings."""

    def resolve(self) -> "TtsConfigLike": ...


class TtsConfigLike(Protocol):
    """The slice of resolved config the application layer reads.

    `settings` is typed as the domain `TtsSettings` rather than `object`: it is
    already a pure domain type, so naming it costs no outward dependency and it is
    what stops an infrastructure config carrying the wrong shape from satisfying
    this Protocol and failing later, inside the engine.

    `pause` sits BESIDE `settings`, not inside it, for the same reason `engine`
    does: `TtsSettings` is the set of knobs handed to an engine, and no engine is
    asked to produce this silence. It is decided when the finished clip is
    assembled, so putting it in `TtsSettings` would hand every engine a parameter
    every engine ignores.

    There is deliberately no `cache_parts` here. Deciding what identifies a clip
    is the use case's policy, and exposing a pre-built tuple meant the override
    path had to hand-roll a second copy of it -- two tuples that had to agree
    with nothing checking that they did.
    """

    @property
    def engine(self) -> str: ...

    @property
    def settings(self) -> TtsSettings: ...

    @property
    def pause(self) -> PauseDuration: ...
