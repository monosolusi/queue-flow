"""Content-addressed MP3 cache on the filesystem.

Synthesis is fast (~0.3 s) but not free, and the same ticket number is announced
again every time staff press "Panggil Ulang". Caching by content hash also gives
the HTTP layer a stable `ETag` for free.

Backed by a Docker named volume so it survives the `restart: always` policy and a
power cut (NFR-REL-02/03): a cold cache after every restart would put a synthesis
on the critical path of the first announcement of every morning.

BOUNDED, not unlimited. `/tts/announcement` and `/tts/preview` are unauthenticated
and exempt from the first-run guard (an `<audio>` element cannot follow a redirect
to wizard HTML), and `preview` takes free-form text -- so the key space any LAN
client can reach is effectively infinite. On an appliance PC a full disk is a
power-cut-class failure, so the store evicts instead of growing. NFR-SEC-01 keeps
this to the store LAN; the bound keeps an accident there from filling the disk.
Eviction is FIFO by write time -- see `_evict_down_to_limit` for what that costs.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

#: Roughly 40 KB a clip, so ~80 MB at the cap. Comfortably more than a busy day of
#: real announcements (ticket numbers x counters, reset daily), which is what makes
#: eviction a backstop against abuse rather than something the store ever notices.
DEFAULT_MAX_ENTRIES = 2000


class AudioCache:
    """Filesystem implementation of `AudioCachePort`.

    Keys are opaque here on purpose -- deriving them is application policy (see
    `SynthesizeAnnouncementUseCase._cache_key`), so this class only persists bytes.
    """

    def __init__(self, root: Path | str, max_entries: int = DEFAULT_MAX_ENTRIES) -> None:
        if max_entries < 1:
            raise ValueError(f"max_entries must be at least 1, got {max_entries}")
        self._root = Path(root)
        self._max_entries = max_entries
        self._root.mkdir(parents=True, exist_ok=True)

    def get(self, key: str) -> bytes | None:
        path = self._path(key)
        try:
            return path.read_bytes()
        except FileNotFoundError:
            return None

    def put(self, key: str, payload: bytes) -> None:
        """Write atomically.

        A same-directory temp file plus `os.replace` means a crash mid-write leaves
        either the old entry or nothing -- never a truncated MP3 that would be
        served as a valid cache hit forever (NFR-REL-02).
        """
        path = self._path(key)
        fd, tmp_name = tempfile.mkstemp(dir=str(self._root), suffix=".part")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, path)
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise
        self._evict_down_to_limit()

    def _evict_down_to_limit(self) -> None:
        """Drop the oldest-written entries until the store is back in bounds.

        FIFO by write time, NOT least-recently-used: `get()` deliberately does not
        refresh the entry's mtime. True LRU would mean one `os.utime` per cache hit
        -- a write on the read path, on the appliance disk this service shares with
        Postgres' WAL.

        The trade that buys is worth naming: under a `/tts/preview` flood the
        oldest-written entries are precisely the real announcement clips (made once,
        re-used every day since), so an abusive burst evicts the hot working set.
        That costs one re-synthesis per evicted clip -- a few hundred ms on the next
        "Panggil Ulang" -- and it cannot corrupt anything, whereas an unbounded
        cache fills the disk, which on a machine that must survive a power cut is a
        different class of failure entirely.

        Eviction is best-effort. A clip that vanishes under us (a concurrent request
        sweeping the same file) is exactly the outcome we wanted; failing the write
        that triggered the sweep would turn a housekeeping race into a 500 on an
        announcement that has already been synthesized.

        `*.mp3` never matches the `.part` temp file of an in-flight write, which is
        what makes "the entry just written is never the one evicted" true. Changing
        that suffix breaks this silently.
        """
        entries = list(self._root.glob("*.mp3"))
        excess = len(entries) - self._max_entries
        if excess <= 0:
            # The common path, forever, once a store settles under the bound: one
            # scandir and no stat() calls. Sorting first would stat every entry on
            # every miss.
            return
        entries.sort(key=self._written_at)
        for stale in entries[:excess]:
            stale.unlink(missing_ok=True)

    @staticmethod
    def _written_at(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:  # pragma: no cover - vanished mid-sweep
            return 0.0

    def clear(self) -> int:
        """Drop every entry; returns how many were removed.

        Called when `ttsConfiguration` changes. Clearing is cheap and unambiguous;
        selective invalidation would need to know which keys derived from the old
        settings, which is precisely what a content-addressed store forgets.
        """
        removed = 0
        for entry in self._root.glob("*.mp3"):
            entry.unlink(missing_ok=True)
            removed += 1
        return removed

    def _path(self, key: str) -> Path:
        return self._root / f"{key}.mp3"
