"""Piper neural TTS engine -- the default `TtsEngine` implementation.

Uses Piper's native Python API rather than shelling out to its CLI: one process,
no per-request interpreter start, and the model stays resident between calls
(measured on this hardware: 0.42 s to load once, then 0.2-0.3 s per announcement).
"""

from __future__ import annotations

import io
import threading
import wave
from pathlib import Path

from ..domain.tts_engine import (
    TtsEngine,
    TtsEngineError,
    TtsSettings,
    Voice,
    VoiceNotAvailableError,
)

ENGINE_ID = "piper"

# Voices shipped in the image. `id` is the Piper model name, which is also the
# on-disk filename stem -- keeping them identical means no lookup table to drift.
_BUNDLED_VOICES = (
    Voice(
        id="id_ID-news_tts-medium",
        label="Indonesia — Berita (netral)",
        language="id-ID",
    ),
)


class PiperTtsEngine(TtsEngine):
    """Synthesizes with a Piper ONNX voice loaded from `models_dir`."""

    def __init__(self, models_dir: Path | str) -> None:
        self._models_dir = Path(models_dir)
        self._loaded: dict[str, object] = {}
        # ONNX Runtime tolerates concurrent Run() calls, but PiperVoice wraps it
        # with its own phonemization and streaming state, so serialise per voice.
        # Announcements are inherently sequential (the board says one at a time),
        # so this costs nothing real and removes a whole class of race.
        self._lock = threading.Lock()

    @property
    def id(self) -> str:
        return ENGINE_ID

    def voices(self) -> list[Voice]:
        """Only voices whose model file is actually present are offered.

        Filtering by presence rather than listing `_BUNDLED_VOICES` blindly means
        the admin dropdown can never offer a voice that would 500 on selection.
        """
        return [v for v in _BUNDLED_VOICES if self._model_path(v.id).exists()]

    def synthesize(self, text: str, settings: TtsSettings) -> bytes:
        voice = self._voice_for(settings.voice_id)
        buffer = io.BytesIO()
        try:
            with self._lock:
                with wave.open(buffer, "wb") as wav_file:
                    voice.synthesize_wav(  # type: ignore[attr-defined]
                        text, wav_file, syn_config=self._synthesis_config(settings)
                    )
        except Exception as exc:  # noqa: BLE001 - surface any engine fault uniformly
            raise TtsEngineError(
                f"piper failed to synthesize {text!r} with voice "
                f"{settings.voice_id!r}: {exc}"
            ) from exc
        return buffer.getvalue()

    def _synthesis_config(self, settings: TtsSettings):
        from piper import SynthesisConfig

        # length_scale is a DURATION multiplier, so it is the reciprocal of speed:
        # speed 2.0 (twice as fast) is length_scale 0.5. Passing speed straight
        # through would invert the control.
        return SynthesisConfig(
            volume=settings.volume,
            length_scale=1.0 / settings.speed,
        )

    def _model_path(self, voice_id: str) -> Path:
        return self._models_dir / f"{voice_id}.onnx"

    def _voice_for(self, voice_id: str):
        """Load and memoise a voice, or explain precisely what is missing."""
        if voice_id in self._loaded:
            return self._loaded[voice_id]

        model_path = self._model_path(voice_id)
        if not model_path.exists():
            available = ", ".join(v.id for v in self.voices()) or "none"
            raise VoiceNotAvailableError(
                f"Piper voice {voice_id!r} not found at {model_path}. "
                f"Available: {available}. Download it with: python -m "
                f"piper.download_voices {voice_id} --data-dir {self._models_dir}"
            )
        # Piper needs the sidecar JSON next to the .onnx; a half-copied model is a
        # confusing failure deep inside onnxruntime, so check it here.
        config_path = model_path.with_suffix(".onnx.json")
        if not config_path.exists():
            raise VoiceNotAvailableError(
                f"Piper voice {voice_id!r} is missing its config sidecar "
                f"{config_path.name}. Re-download the voice; the .onnx alone is "
                "not usable."
            )

        from piper import PiperVoice

        with self._lock:
            if voice_id not in self._loaded:  # re-check under lock
                self._loaded[voice_id] = PiperVoice.load(str(model_path))
        return self._loaded[voice_id]
