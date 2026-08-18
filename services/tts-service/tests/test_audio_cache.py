"""Filesystem cache: durability of a write, and the bound that keeps it finite."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.infrastructure.audio_cache import DEFAULT_MAX_ENTRIES, AudioCache


def test_round_trips_bytes_under_an_opaque_key(tmp_path: Path) -> None:
    cache = AudioCache(tmp_path)
    cache.put("abc123", b"ID3\x00clip")

    assert cache.get("abc123") == b"ID3\x00clip"


def test_a_miss_is_none_rather_than_an_error(tmp_path: Path) -> None:
    assert AudioCache(tmp_path).get("never-written") is None


def test_creates_its_directory_so_a_fresh_volume_needs_no_setup(tmp_path: Path) -> None:
    root = tmp_path / "nested" / "cache"
    AudioCache(root).put("k", b"x")

    assert (root / "k.mp3").read_bytes() == b"x"


def test_leaves_no_partial_file_behind_for_a_later_hit_to_serve(tmp_path: Path) -> None:
    """NFR-REL-02: a truncated MP3 would be served as a valid hit forever."""
    cache = AudioCache(tmp_path)
    cache.put("k", b"complete")

    leftovers = list(tmp_path.glob("*.part"))
    assert leftovers == []
    assert cache.get("k") == b"complete"


def test_clear_drops_every_entry_and_reports_how_many(tmp_path: Path) -> None:
    cache = AudioCache(tmp_path)
    for key in ("a", "b", "c"):
        cache.put(key, b"x")

    assert cache.clear() == 3
    assert cache.get("a") is None


def _write_aged(cache: AudioCache, root: Path, key: str, age: int) -> Path:
    """Write an entry and stamp its mtime, so ordering is not clock-resolution luck."""
    cache.put(key, b"x")
    path = root / f"{key}.mp3"
    os.utime(path, (1_000_000 - age, 1_000_000 - age))
    return path


def test_a_store_under_its_bound_evicts_nothing(tmp_path: Path) -> None:
    """The common path: no entry disappears just because another was written."""
    cache = AudioCache(tmp_path, max_entries=3)
    cache.put("a", b"1")
    cache.put("b", b"2")

    assert cache.get("a") == b"1"
    assert cache.get("b") == b"2"


def test_evicts_the_oldest_entries_once_the_store_is_over_its_bound(
    tmp_path: Path,
) -> None:
    # `/tts/preview?text=` is unauthenticated free-form text, so the reachable key
    # space is unbounded. On an appliance PC that must survive a power cut, an
    # unbounded cache is a disk-fill waiting to happen.
    cache = AudioCache(tmp_path, max_entries=3)
    for age, key in enumerate(("newest", "middle", "oldest")):
        _write_aged(cache, tmp_path, key, age * 100)

    _write_aged(cache, tmp_path, "arrival", 0)

    assert cache.get("oldest") is None, "the least recently written entry should go"
    assert cache.get("arrival") == b"x"
    assert cache.get("newest") == b"x"
    assert len(list(tmp_path.glob("*.mp3"))) == 3


def test_the_bound_holds_across_many_writes(tmp_path: Path) -> None:
    """One eviction per put is not enough if a put can add more than it removes."""
    cache = AudioCache(tmp_path, max_entries=5)
    for i in range(50):
        _write_aged(cache, tmp_path, f"k{i}", 50 - i)

    assert len(list(tmp_path.glob("*.mp3"))) == 5


def test_an_entry_just_written_is_never_the_one_evicted(tmp_path: Path) -> None:
    """Evicting the arrival would make the cache a no-op at the bound."""
    cache = AudioCache(tmp_path, max_entries=1)
    # Stamped rather than relying on two puts landing in different mtime ticks:
    # `sorted` is stable and glob order is scandir order, so same-tick entries
    # would evict arbitrarily and this spec would pass or fail by filesystem
    # timestamp resolution.
    _write_aged(cache, tmp_path, "first", 100)
    _write_aged(cache, tmp_path, "second", 0)

    assert cache.get("second") == b"x"
    assert cache.get("first") is None


def test_rejects_a_bound_that_would_make_the_cache_useless(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="at least 1"):
        AudioCache(tmp_path, max_entries=0)


def test_the_default_bound_is_generous_enough_to_be_a_backstop_not_a_policy() -> None:
    # A real store announces at most (tickets x counters) clips a day and resets
    # daily, so the cap must never be what a working store bumps into.
    assert DEFAULT_MAX_ENTRIES >= 1000
