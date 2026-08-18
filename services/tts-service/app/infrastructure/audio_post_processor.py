"""ffmpeg audio finishing: trim, loudness-normalise, prepend the bell, encode MP3.

Kept out of the engines on purpose (SRP): every engine returns raw WAV and this
module owns the parts that must sound identical no matter which engine produced
them. Swapping Piper for human recordings must not change the loudness of the
board.

Everything here shells out to ffmpeg. It is a build- and runtime dependency of the
image, declared in the Dockerfile.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from ..domain.ports import AudioFinishingError

# Speech target. -16 LUFS is the usual spoken-word integrated loudness.
SPEECH_LUFS = -16.0
# The bell is an attention cue, not content. A pure tone reads as louder than
# speech at equal integrated loudness, so it is normalised to a QUIETER target
# rather than attenuated after the fact -- attenuating post-loudnorm would just be
# undone by the next stage's gain.
BELL_LUFS = -20.0

SAMPLE_RATE = 22_050
MP3_BITRATE = "64k"

# Leading/trailing silence must go before concatenation, or the gap between the
# bell and the speech inherits whatever pause the synthesizer happened to emit.
# The areverse sandwich is the canonical ffmpeg both-ends trim.
_TRIM = (
    "silenceremove=start_periods=1:start_silence=0:start_threshold=-50dB:detection=peak,"
    "areverse,"
    "silenceremove=start_periods=1:start_silence=0:start_threshold=-50dB:detection=peak,"
    "areverse"
)


class AudioProcessingError(AudioFinishingError):
    """ffmpeg failed or is missing.

    Subclasses the domain-declared `AudioFinishingError` so the layers that catch a
    finishing failure -- the use case and the HTTP adapter -- never have to import
    this module. Naming ffmpeg is this class's job; reacting to a failed clip is
    not.
    """


@dataclass(frozen=True)
class _Loudness:
    """Measured input loudness from a `loudnorm` analysis pass."""

    input_i: float
    input_tp: float
    input_lra: float
    input_thresh: float
    target_offset: float


def _run(args: list[str], *, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            args, input=stdin, capture_output=True, check=False
        )
    except FileNotFoundError as exc:  # pragma: no cover - environment problem
        raise AudioProcessingError(
            "ffmpeg not found on PATH. It is required to normalise and encode "
            "announcement audio; install it (macOS: `brew install ffmpeg`) or "
            "rebuild the tts-service image, which installs it."
        ) from exc
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace")[-2000:]
        raise AudioProcessingError(
            f"ffmpeg failed ({result.returncode}): {' '.join(args[:6])}…\n{stderr}"
        )
    return result


def _measure(wav_path: Path, target_lufs: float) -> _Loudness:
    """Analysis pass for two-pass loudnorm.

    Two passes are not optional here. `loudnorm` in single-pass mode adapts
    dynamically and needs roughly three seconds to converge; an announcement clip
    is well under two. Single-pass therefore produces erratic levels -- the exact
    "bell blasts, words whisper" failure this module exists to prevent.
    """
    result = _run(
        [
            "ffmpeg", "-hide_banner", "-nostats", "-i", str(wav_path),
            "-af", f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11:print_format=json",
            "-f", "null", "-",
        ]
    )
    stderr = result.stderr.decode("utf-8", "replace")
    # The JSON block is the last {...} ffmpeg prints on stderr.
    match = re.findall(r"\{[^{}]*\}", stderr, flags=re.DOTALL)
    if not match:  # pragma: no cover - would mean an ffmpeg format change
        raise AudioProcessingError(
            "could not parse loudnorm analysis output from ffmpeg stderr"
        )
    data = json.loads(match[-1])
    return _Loudness(
        input_i=float(data["input_i"]),
        input_tp=float(data["input_tp"]),
        input_lra=float(data["input_lra"]),
        input_thresh=float(data["input_thresh"]),
        target_offset=float(data["target_offset"]),
    )


def _normalise_filter(measured: _Loudness, target_lufs: float) -> str:
    return (
        f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11"
        f":measured_I={measured.input_i}"
        f":measured_TP={measured.input_tp}"
        f":measured_LRA={measured.input_lra}"
        f":measured_thresh={measured.input_thresh}"
        f":offset={measured.target_offset}"
        ":linear=true"
    )


def synthesize_bell(destination: Path) -> None:
    """Render the two-tone attention chime with ffmpeg alone.

    Generated rather than vendored: no asset to download, no third-party licence
    to audit, and it cannot drift out of sync with the speech pipeline's sample
    rate. A5 (880 Hz) into E6 (1318.5 Hz), the second tone delayed and given a
    long decay so it reads as a chime instead of a beep.
    """
    _run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"sine=frequency=880:duration=0.18:sample_rate={SAMPLE_RATE}",
            "-f", "lavfi", "-i", f"sine=frequency=1318.5:duration=0.55:sample_rate={SAMPLE_RATE}",
            "-filter_complex",
            "[0:a]afade=t=out:st=0.10:d=0.08[a];"
            "[1:a]adelay=170|170,afade=t=out:st=0.28:d=0.44[b];"
            "[a][b]amix=inputs=2:normalize=0",
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            str(destination),
        ]
    )


def _finish(source: Path, destination: Path, *, target_lufs: float, pad_seconds: float) -> None:
    """Trim, normalise to `target_lufs`, pad, and write mono WAV."""
    measured = _measure(source, target_lufs)
    filters = f"{_TRIM},{_normalise_filter(measured, target_lufs)}"
    if pad_seconds > 0:
        filters += f",apad=pad_dur={pad_seconds}"
    _run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(source), "-af", filters,
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            str(destination),
        ]
    )


def _trim_and_pad(source: Path, destination: Path, *, pad_seconds: float) -> None:
    """Strip a segment's own leading/trailing silence, then append an exact gap.

    Deliberately does NOT loudness-normalise. Normalising each segment on its own
    would drag every one of them to the same integrated loudness, which for a
    0.4-second segment like "dua" means being pulled up next to a two-second one
    -- the announcement comes out flat and machine-like. Loudness is measured
    once, over the joined speech, by `_finish`.

    Trimming first is what makes the gap exact: whatever silence the synthesizer
    chose to emit around the words is removed, so the pause is the configured
    length rather than the configured length plus an arbitrary remainder.
    """
    filters = _TRIM
    if pad_seconds > 0:
        filters += f",apad=pad_dur={pad_seconds}"
    _run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(source), "-af", filters,
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            str(destination),
        ]
    )


def _join_speech(segments: list[bytes], gap_ms: int, work: Path) -> Path:
    """Concatenate speech segments with `gap_ms` of silence between them.

    A single segment is written straight through with no ffmpeg pass at all, so
    the default (unpaused) delivery reaches `_finish` exactly as it always did --
    the no-pause path is not merely equivalent to the old one, it is the old one.
    """
    if not segments:
        # The port promises a clip; an empty concat listing would instead surface
        # as an opaque ffmpeg failure several steps later.
        raise AudioProcessingError("cannot build an announcement from zero speech segments")
    if len(segments) == 1:
        raw = work / "speech-raw.wav"
        raw.write_bytes(segments[0])
        return raw

    gap_seconds = gap_ms / 1000
    parts: list[Path] = []
    for index, segment in enumerate(segments):
        raw = work / f"segment-{index}-raw.wav"
        raw.write_bytes(segment)
        trimmed = work / f"segment-{index}.wav"
        # The gap goes AFTER each segment except the last; a trailing gap there
        # would just be swallowed by `_finish`'s own trim and then re-added as
        # its tail pad, so asking for it would be asking for nothing.
        last = index == len(segments) - 1
        _trim_and_pad(raw, trimmed, pad_seconds=0 if last else gap_seconds)
        parts.append(trimmed)

    listing = work / "speech-concat.txt"
    listing.write_text("".join(f"file '{part}'\n" for part in parts), encoding="utf-8")
    joined = work / "speech-raw.wav"
    _run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(listing),
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            str(joined),
        ]
    )
    return joined


def build_announcement_mp3(speech_segments: list[bytes], gap_ms: int) -> bytes:
    """Bell + normalised speech, encoded as a single mono MP3.

    Returns one file because the TV plays one file: the browser's autoplay gate is
    per-`play()` call, so a two-request announcement would double the chance of a
    blocked start and would need client-side sequencing -- exactly the complexity
    this service was created to absorb. That reasoning is also why `gap_ms` is
    handled here rather than by the TV playing several clips in a row.

    Segments arrive already split by the domain (it knows where a pause belongs
    in the sentence); this function only renders the silence and joins them.
    """
    with tempfile.TemporaryDirectory(prefix="qms-tts-") as tmp:
        work = Path(tmp)
        raw_speech = _join_speech(speech_segments, gap_ms, work)

        bell_raw = work / "bell-raw.wav"
        synthesize_bell(bell_raw)

        bell = work / "bell.wav"
        speech = work / "speech.wav"
        # A short gap after the chime, a longer tail after the speech so the board
        # is not immediately cut off by the next queued announcement.
        _finish(bell_raw, bell, target_lufs=BELL_LUFS, pad_seconds=0.12)
        _finish(raw_speech, speech, target_lufs=SPEECH_LUFS, pad_seconds=0.25)

        listing = work / "concat.txt"
        listing.write_text(f"file '{bell}'\nfile '{speech}'\n", encoding="utf-8")

        out = work / "announcement.mp3"
        _run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "concat", "-safe", "0", "-i", str(listing),
                "-c:a", "libmp3lame", "-b:a", MP3_BITRATE,
                "-ac", "1", "-ar", str(SAMPLE_RATE),
                # Strip metadata so byte output depends only on the audio, which
                # keeps the cache key honest across ffmpeg patch releases.
                "-map_metadata", "-1", "-id3v2_version", "0", "-write_id3v1", "0",
                str(out),
            ]
        )
        return out.read_bytes()


def build_silent_mp3(duration_seconds: float = 0.05) -> bytes:
    """A near-instant silent MP3 for the TV's autoplay probe.

    The TV needs something it can legitimately `play()` to discover whether the
    browser will allow audio at all, and to consume the user's unlock gesture. It
    must be silent so the probe is inaudible to people in the store, and it must
    NOT be loudness-normalised -- normalising silence asks ffmpeg for unbounded
    gain.
    """
    with tempfile.TemporaryDirectory(prefix="qms-tts-probe-") as tmp:
        out = Path(tmp) / "probe.mp3"
        _run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi",
                "-i", f"anullsrc=r={SAMPLE_RATE}:cl=mono",
                "-t", str(duration_seconds),
                "-c:a", "libmp3lame", "-b:a", "32k",
                "-map_metadata", "-1", "-id3v2_version", "0", "-write_id3v1", "0",
                str(out),
            ]
        )
        return out.read_bytes()
