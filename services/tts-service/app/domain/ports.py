"""Outbound ports the application layer depends on.

Structural `Protocol`s rather than ABCs: the concrete classes in `infrastructure/`
satisfy them without importing this module, so the dependency arrow points inward
only (DIP). Mirrors how core-api defines repository interfaces in its domain layer
and keeps implementations in infrastructure.

Everything here is IO-free by construction -- these are the *shapes* of IO, not IO.
"""

from __future__ import annotations

from typing import Protocol


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
    """

    def __call__(self, speech_wav: bytes) -> bytes: ...


class TtsConfigProvider(Protocol):
    """Supplies the currently configured engine and delivery settings."""

    def resolve(self) -> "TtsConfigLike": ...


class TtsConfigLike(Protocol):
    """The slice of resolved config the application layer reads."""

    @property
    def engine(self) -> str: ...

    @property
    def cache_parts(self) -> tuple[object, ...]: ...

    @property
    def settings(self) -> object: ...
