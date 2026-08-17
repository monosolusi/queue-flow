"""Human-recorded voice engine -- concatenates word WAVs from a mounted folder.

This exists in the first release on purpose. "The model is swappable" is a claim
that only means something if there are two engines, and this is the one a store
actually wants long-term: a receptionist reading ~40 short words sounds better than
any small neural voice, and it sidesteps the unresolved licensing of the bundled
Piper voice entirely.

It also proves the `TtsEngine` port is honest. This engine is a *concatenator* and
Piper is a *sentence synthesizer*, yet both satisfy the same sentence-level
contract -- which is exactly what a word-level port would have made impossible.
"""

from __future__ import annotations

import io
import re
import wave
from pathlib import Path

from ..domain.tts_engine import (
    TtsEngine,
    TtsEngineError,
    TtsSettings,
    Voice,
    VoiceNotAvailableError,
)

ENGINE_ID = "prerecorded"

_WORD = re.compile(r"[a-z]+")


class PrerecordedTtsEngine(TtsEngine):
    """Builds an utterance by joining one WAV per spoken word.

    Layout: `<recordings_dir>/<voice_id>/<word>.wav`, mono, all at one sample rate.
    A voice is any subdirectory, so adding a second speaker means dropping in a
    folder -- no code change and no config schema change.
    """

    def __init__(self, recordings_dir: Path | str) -> None:
        self._root = Path(recordings_dir)

    @property
    def id(self) -> str:
        return ENGINE_ID

    def voices(self) -> list[Voice]:
        if not self._root.is_dir():
            return []
        return [
            Voice(id=entry.name, label=f"Rekaman — {entry.name}", language="id-ID")
            for entry in sorted(self._root.iterdir())
            if entry.is_dir() and any(entry.glob("*.wav"))
        ]

    def synthesize(self, text: str, settings: TtsSettings) -> bytes:
        voice_dir = self._root / settings.voice_id
        if not voice_dir.is_dir():
            available = ", ".join(v.id for v in self.voices()) or "none"
            raise VoiceNotAvailableError(
                f"No recordings folder for voice {settings.voice_id!r} at "
                f"{voice_dir}. Available: {available}."
            )

        words = _WORD.findall(text.lower())
        if not words:
            raise TtsEngineError(f"no pronounceable words in {text!r}")

        missing = [w for w in dict.fromkeys(words) if not (voice_dir / f"{w}.wav").exists()]
        if missing:
            # Fail loudly with the full list rather than dropping words: a silently
            # skipped word produces a WRONG announcement ("silakan ke loket" with
            # no number), which is worse for a visitor than an obvious error.
            raise VoiceNotAvailableError(
                f"Voice {settings.voice_id!r} is missing recordings for: "
                f"{', '.join(missing)}. Add <word>.wav for each to {voice_dir}."
            )

        return self._concatenate([voice_dir / f"{w}.wav" for w in words])

    @staticmethod
    def _concatenate(paths: list[Path]) -> bytes:
        """Join mono WAVs, using the first file's format as the reference.

        Pure stdlib -- no ffmpeg needed here; the shared post-processor handles
        normalisation and encoding downstream, so this only has to produce valid
        WAV bytes.
        """
        buffer = io.BytesIO()
        writer: wave.Wave_write | None = None
        reference: tuple[int, int, int] | None = None
        try:
            for path in paths:
                with wave.open(str(path), "rb") as source:
                    params = (
                        source.getnchannels(),
                        source.getsampwidth(),
                        source.getframerate(),
                    )
                    if writer is None:
                        reference = params
                        writer = wave.open(buffer, "wb")
                        writer.setnchannels(params[0])
                        writer.setsampwidth(params[1])
                        writer.setframerate(params[2])
                    elif params != reference:
                        raise TtsEngineError(
                            f"{path.name} is {params} but the utterance started as "
                            f"{reference}; all recordings for one voice must share "
                            "channel count, sample width and sample rate."
                        )
                    writer.writeframes(source.readframes(source.getnframes()))
        finally:
            if writer is not None:
                writer.close()
        return buffer.getvalue()
