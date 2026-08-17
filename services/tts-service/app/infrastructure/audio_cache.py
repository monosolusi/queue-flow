"""Content-addressed MP3 cache on the filesystem.

Synthesis is fast (~0.3 s) but not free, and the same ticket number is announced
again every time staff press "Panggil Ulang". Caching by content hash also gives
the HTTP layer a stable `ETag` for free.

Backed by a Docker named volume so it survives the `restart: always` policy and a
power cut (NFR-REL-02/03): a cold cache after every restart would put a synthesis
on the critical path of the first announcement of every morning.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


class AudioCache:
    """Filesystem implementation of `AudioCachePort`.

    Keys are opaque here on purpose -- deriving them is application policy (see
    `SynthesizeAnnouncementUseCase._cache_key`), so this class only persists bytes.
    """

    def __init__(self, root: Path | str) -> None:
        self._root = Path(root)
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
