"""Integration tests against the real tools.

These are the only tests that need ffmpeg or the 63 MB Piper model, so each is
SKIPPED (never failed) when its dependency is absent. That keeps `npm run verify`
green on a fresh clone -- the model is downloaded at image build time, not
committed -- while still exercising the real pipeline on a machine set up for
tts-service work.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

import pytest

from app.domain.announcement import AnnouncementRequest, build_script
from app.domain.tts_engine import TtsSettings, VoiceNotAvailableError
from app.infrastructure.audio_post_processor import (
    SAMPLE_RATE,
    build_announcement_mp3,
    build_silent_mp3,
    synthesize_bell,
)
from app.infrastructure.piper_engine import PiperTtsEngine

SERVICE_ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = Path(os.environ.get("QMS_TTS_MODELS_DIR", SERVICE_ROOT / "models"))
DEFAULT_VOICE = "id_ID-news_tts-medium"

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None,
    reason="ffmpeg not on PATH (installed in the tts-service image; `brew install ffmpeg` locally)",
)
needs_model = pytest.mark.skipif(
    not (MODELS_DIR / f"{DEFAULT_VOICE}.onnx").exists(),
    reason=(
        f"Piper voice {DEFAULT_VOICE} not in {MODELS_DIR} "
        f"(run: python -m piper.download_voices {DEFAULT_VOICE} --data-dir models)"
    ),
)

# MP3 frames start with a sync word: 11 set bits. Checking this proves we produced
# real audio and not, say, an HTML error page saved with an .mp3 name.
MP3_SYNC = b"\xff"


def wav_of(payload: bytes) -> wave.Wave_read:
    return wave.open(io.BytesIO(payload), "rb")


@needs_ffmpeg
def test_bell_is_generated_at_the_pipeline_sample_rate(tmp_path: Path) -> None:
    """Generated, not vendored: no asset to license and it cannot drift out of
    sync with the speech sample rate."""
    destination = tmp_path / "bell.wav"
    synthesize_bell(destination)

    with wave.open(str(destination), "rb") as bell:
        assert bell.getframerate() == SAMPLE_RATE
        assert bell.getnchannels() == 1
        assert bell.getnframes() > 0


@needs_ffmpeg
def test_silent_probe_is_a_real_but_inaudible_mp3() -> None:
    """Silent so it is inaudible in the store, real so the browser will play it."""
    payload = build_silent_mp3()
    assert payload.startswith(MP3_SYNC)
    assert 0 < len(payload) < 20_000


@needs_ffmpeg
def test_announcement_mp3_is_bell_plus_speech_and_longer_than_either(
    tmp_path: Path,
) -> None:
    """Guards the concatenation step: a bug that dropped the speech would still
    produce a valid MP3, so length is what distinguishes it."""
    speech = tmp_path / "speech.wav"
    with wave.open(str(speech), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        # ~0.6 s of low-level tone; silence would be trimmed away entirely.
        handle.writeframes(b"\x00\x08" * int(SAMPLE_RATE * 0.6))

    payload = build_announcement_mp3([speech.read_bytes()], 0)

    assert payload.startswith(MP3_SYNC)
    # Bell (~0.7 s incl. pad) + speech (~0.85 s incl. pad) at 64 kbps mono.
    assert len(payload) > 8_000


def mp3_duration_seconds(payload: bytes) -> float:
    """Decode an MP3 back to WAV with ffmpeg and measure it.

    ffmpeg rather than ffprobe: these tests already gate on ffmpeg, and some
    distributions package ffprobe separately -- gating on a second binary would
    turn a skip into a failure on a machine that is set up correctly.
    """
    with tempfile.TemporaryDirectory(prefix="qms-tts-test-") as tmp:
        source = Path(tmp) / "clip.mp3"
        source.write_bytes(payload)
        decoded = Path(tmp) / "clip.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", str(source), str(decoded)],
            check=True,
        )
        with wave.open(str(decoded), "rb") as handle:
            return handle.getnframes() / handle.getframerate()


def _tone_wav(seconds: float) -> bytes:
    """A low-level tone of a known length. Silence would be trimmed away entirely,
    so a tone is what makes a duration measurable through the pipeline."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(b"\x00\x08" * int(SAMPLE_RATE * seconds))
    return buffer.getvalue()


@needs_ffmpeg
def test_a_configured_pause_lengthens_the_clip_by_roughly_that_much() -> None:
    """The whole feature, measured: the same words with a gap must take longer.

    Duration rather than byte length, and a range rather than an exact figure --
    MP3 frame packing and the loudness pass both move the byte count around, so
    an equality assertion here would be brittle in a way that says nothing about
    whether the pause is audible.
    """
    segments = [_tone_wav(0.4), _tone_wav(0.4), _tone_wav(0.4)]

    unpaused = mp3_duration_seconds(build_announcement_mp3(segments, 0))
    paused = mp3_duration_seconds(build_announcement_mp3(segments, 500))

    # Two seams x 500 ms. Tolerance covers the MP3 frame grid and the trim.
    assert 0.8 < paused - unpaused < 1.2


@needs_ffmpeg
def test_a_single_segment_ignores_the_gap_entirely() -> None:
    """The no-pause default must not merely resemble the old pipeline -- with one
    segment there is no seam, so a gap has nowhere to go and must change nothing."""
    one = [_tone_wav(0.6)]

    without = mp3_duration_seconds(build_announcement_mp3(one, 0))
    withgap = mp3_duration_seconds(build_announcement_mp3(one, 500))

    assert abs(withgap - without) < 0.1


@needs_ffmpeg
@needs_model
def test_full_pipeline_produces_a_playable_indonesian_announcement() -> None:
    """The end-to-end path the TV board hits, with the real voice and real ffmpeg."""
    engine = PiperTtsEngine(MODELS_DIR)
    script = build_script(AnnouncementRequest(ticket_number="A-005", counter_id=2))

    speech = engine.synthesize(script.text, TtsSettings(voice_id=DEFAULT_VOICE))
    with wav_of(speech) as rendered:
        assert rendered.getframerate() == SAMPLE_RATE
        assert rendered.getnframes() > SAMPLE_RATE * 0.5  # at least half a second

    payload = build_announcement_mp3([speech], 0)
    assert payload.startswith(MP3_SYNC)
    assert 10_000 < len(payload) < 200_000


@needs_model
def test_piper_offers_the_bundled_indonesian_voice() -> None:
    voices = PiperTtsEngine(MODELS_DIR).voices()
    assert [v.id for v in voices] == [DEFAULT_VOICE]
    assert voices[0].language == "id-ID"


@needs_model
def test_speed_maps_to_the_reciprocal_of_piper_length_scale() -> None:
    """`length_scale` is a DURATION multiplier, so speed 2.0 must be 0.5.

    Passing speed straight through would invert the control: a manager asking for
    faster speech would get slower speech.
    """
    engine = PiperTtsEngine(MODELS_DIR)
    config = engine._synthesis_config(TtsSettings(voice_id=DEFAULT_VOICE, speed=2.0))
    assert config.length_scale == pytest.approx(0.5)


@needs_model
def test_faster_speed_really_produces_shorter_audio() -> None:
    """Behavioural counterpart to the mapping test above -- catches an inversion
    even if the internal attribute is renamed."""
    engine = PiperTtsEngine(MODELS_DIR)
    text = "nomor antrian a lima, silakan ke loket dua"

    with wav_of(engine.synthesize(text, TtsSettings(voice_id=DEFAULT_VOICE, speed=1.0))) as normal:
        normal_frames = normal.getnframes()
    with wav_of(engine.synthesize(text, TtsSettings(voice_id=DEFAULT_VOICE, speed=1.6))) as fast:
        fast_frames = fast.getnframes()

    assert fast_frames < normal_frames


def test_a_missing_model_explains_how_to_get_it(tmp_path: Path) -> None:
    """Runs everywhere -- an empty directory needs no model installed."""
    engine = PiperTtsEngine(tmp_path)
    with pytest.raises(VoiceNotAvailableError) as excinfo:
        engine.synthesize("satu", TtsSettings(voice_id=DEFAULT_VOICE))
    assert "download_voices" in str(excinfo.value)


def test_a_model_without_its_config_sidecar_fails_clearly(tmp_path: Path) -> None:
    """The .onnx alone is unusable; without this check the failure surfaces deep
    inside onnxruntime with no hint about the missing .onnx.json."""
    (tmp_path / f"{DEFAULT_VOICE}.onnx").write_bytes(b"not really a model")
    engine = PiperTtsEngine(tmp_path)

    with pytest.raises(VoiceNotAvailableError, match="sidecar"):
        engine.synthesize("satu", TtsSettings(voice_id=DEFAULT_VOICE))
