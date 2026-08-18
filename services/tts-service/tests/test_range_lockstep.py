"""Drift gate: the delivery ranges here must stay a superset of core-api's.

The speed/volume/pause bounds are deliberately duplicated across a Python/TS
boundary rather than shared -- the repo's precedent for a cross-service contract
it cannot import (the ESC/POS byte composer, the design-token copies). What that
precedent also has, and what a prose rule alone does not give, is something that
FAILS when the copies drift.

The rule is "narrower, never wider, at each step outward": core-api must never
accept a value this service would reject, because this service's response to an
out-of-range knob is to discard the WHOLE settings object and fall back -- so a
too-wide core-api range shows up as a store silently losing its configured voice,
not as an error anyone sees.

Reads core-api's TypeScript source directly. That is the same `node:fs` static
guard the admin tree already uses for CSS, and it is the only way to check a
constant that lives on the other side of a language boundary.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.domain.tts_engine import MAX_PAUSE_MS, MIN_PAUSE_MS, TtsSettings

CORE_API_VO = (
    Path(__file__).resolve().parents[2]
    / "core-api/src/domain/store-config/value-objects/tts-configuration.ts"
)


def test_the_gate_can_actually_see_the_file_it_guards() -> None:
    """A drift gate that quietly skips is not a gate.

    The ffmpeg/model specs in this suite skip because their dependency is a 63 MB
    download that a fresh clone legitimately lacks. This one's dependency is a
    sibling file in the same repository, so a missing path means the file moved
    and the guard silently stopped guarding -- which must fail, not skip.
    """
    assert CORE_API_VO.exists(), (
        f"core-api's TtsConfiguration is not at {CORE_API_VO}. If it moved, update "
        "this path -- otherwise the range lock-step below stops being checked."
    )


def core_api_constant(name: str) -> float:
    """Parse `export const NAME = <number>;` out of the value object."""
    source = CORE_API_VO.read_text(encoding="utf-8")
    match = re.search(rf"^export const {name} = ([0-9.]+);$", source, flags=re.M)
    assert match is not None, f"{name} not found in {CORE_API_VO.name}"
    return float(match.group(1))


def test_core_api_speed_range_is_inside_what_this_service_accepts() -> None:
    # Probing TtsSettings rather than re-declaring its bounds: the invariant is
    # "core-api's extremes are constructable here", and constructing them states
    # that more directly than comparing two numbers would.
    TtsSettings(voice_id="v", speed=core_api_constant("MIN_SPEED"))
    TtsSettings(voice_id="v", speed=core_api_constant("MAX_SPEED"))


def test_core_api_volume_range_is_inside_what_this_service_accepts() -> None:
    TtsSettings(voice_id="v", volume=core_api_constant("MIN_VOLUME"))
    TtsSettings(voice_id="v", volume=core_api_constant("MAX_VOLUME"))


def test_core_api_pause_range_is_inside_what_this_service_accepts() -> None:
    assert core_api_constant("MIN_PAUSE_MS") >= MIN_PAUSE_MS
    assert core_api_constant("MAX_PAUSE_MS") <= MAX_PAUSE_MS
