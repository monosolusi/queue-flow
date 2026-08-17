"""The human-recording engine — the second implementation that proves the port.

Uses real WAV files written with the stdlib `wave` module, so these tests need
neither ffmpeg nor Piper.
"""

from __future__ import annotations

import io
import wave
from pathlib import Path

import pytest

from app.domain.tts_engine import (
    TtsEngineError,
    TtsSettings,
    VoiceNotAvailableError,
)
from app.infrastructure.prerecorded_engine import PrerecordedTtsEngine

SAMPLE_RATE = 22_050


def write_wav(path: Path, *, frames: int = 512, rate: int = SAMPLE_RATE, channels: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x01" * frames * channels)


def voice_dir(tmp_path: Path, words: list[str], voice: str = "bu-sari") -> Path:
    for word in words:
        write_wav(tmp_path / voice / f"{word}.wav")
    return tmp_path


ANNOUNCEMENT_WORDS = ["nomor", "antrian", "a", "lima", "silakan", "ke", "loket", "dua"]


def test_concatenates_one_recording_per_spoken_word(tmp_path: Path) -> None:
    root = voice_dir(tmp_path, ANNOUNCEMENT_WORDS)
    engine = PrerecordedTtsEngine(root)

    payload = engine.synthesize(
        "nomor antrian a lima, silakan ke loket dua",
        TtsSettings(voice_id="bu-sari"),
    )

    with wave.open(io.BytesIO(payload), "rb") as result:
        # 8 words x 512 frames each.
        assert result.getnframes() == 8 * 512
        assert result.getnchannels() == 1
        assert result.getframerate() == SAMPLE_RATE


def test_satisfies_the_same_sentence_level_port_as_the_neural_engine(
    tmp_path: Path,
) -> None:
    """A concatenator and a sentence synthesizer behind one interface.

    This is the whole point of the sentence-level contract: a word-level port would
    have forced every future engine to be a concatenator.
    """
    engine = PrerecordedTtsEngine(voice_dir(tmp_path, ["satu"]))
    assert engine.id == "prerecorded"
    assert engine.synthesize("satu", TtsSettings(voice_id="bu-sari")).startswith(b"RIFF")


def test_lists_each_recordings_folder_as_a_selectable_voice(tmp_path: Path) -> None:
    voice_dir(tmp_path, ["satu"], voice="bu-sari")
    voice_dir(tmp_path, ["satu"], voice="pak-budi")
    (tmp_path / "empty-folder").mkdir()

    ids = {v.id for v in PrerecordedTtsEngine(tmp_path).voices()}

    # An empty folder is not offered -- selecting it would fail on first use.
    assert ids == {"bu-sari", "pak-budi"}


def test_offers_no_voices_when_the_recordings_directory_is_absent(tmp_path: Path) -> None:
    assert PrerecordedTtsEngine(tmp_path / "nope").voices() == []


def test_names_every_missing_word_instead_of_dropping_it(tmp_path: Path) -> None:
    """Skipping a missing word yields a WRONG announcement, not a degraded one.

    "silakan ke loket" with the number silently omitted sends the visitor to a
    counter without telling them whose turn it is -- worse than an audible failure.
    """
    root = voice_dir(tmp_path, ["nomor", "antrian", "a"])
    engine = PrerecordedTtsEngine(root)

    with pytest.raises(VoiceNotAvailableError) as excinfo:
        engine.synthesize("nomor antrian a lima ke loket dua", TtsSettings(voice_id="bu-sari"))

    message = str(excinfo.value)
    for missing in ("lima", "ke", "loket", "dua"):
        assert missing in message


def test_rejects_an_unknown_voice_and_lists_what_is_available(tmp_path: Path) -> None:
    engine = PrerecordedTtsEngine(voice_dir(tmp_path, ["satu"]))
    with pytest.raises(VoiceNotAvailableError, match="bu-sari"):
        engine.synthesize("satu", TtsSettings(voice_id="pak-tidak-ada"))


def test_rejects_text_with_no_pronounceable_words(tmp_path: Path) -> None:
    engine = PrerecordedTtsEngine(voice_dir(tmp_path, ["satu"]))
    with pytest.raises(TtsEngineError):
        engine.synthesize("123 !!!", TtsSettings(voice_id="bu-sari"))


def test_rejects_recordings_with_mismatched_formats(tmp_path: Path) -> None:
    """Concatenating a 44.1 kHz clip into a 22.05 kHz utterance would play at the
    wrong pitch and speed -- silent corruption, so fail loudly instead."""
    write_wav(tmp_path / "bu-sari" / "satu.wav", rate=SAMPLE_RATE)
    write_wav(tmp_path / "bu-sari" / "dua.wav", rate=44_100)
    engine = PrerecordedTtsEngine(tmp_path)

    with pytest.raises(TtsEngineError, match="must share"):
        engine.synthesize("satu dua", TtsSettings(voice_id="bu-sari"))


def test_deduplicates_the_missing_word_report(tmp_path: Path) -> None:
    engine = PrerecordedTtsEngine(voice_dir(tmp_path, ["satu"]))
    with pytest.raises(VoiceNotAvailableError) as excinfo:
        engine.synthesize("dua dua dua", TtsSettings(voice_id="bu-sari"))
    assert str(excinfo.value).count("dua") == 1
