"""Reads `ttsConfiguration` from core-api's public system-config endpoint.

Dependency direction is deliberate: tts-service depends on core-api, never the
reverse. There is no "push config to the TTS service" endpoint, which means no new
authenticated surface, no admin→tts coupling, and core-api stays unaware that this
service exists.

`GET /api/system/config` is already public (it has no guards), so no credentials
are involved.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from ..domain.tts_engine import TtsSettings

logger = logging.getLogger(__name__)

DEFAULT_ENGINE = "piper"
DEFAULT_VOICE = "id_ID-news_tts-medium"


#: Silence inserted at each pause point inside the announcement, milliseconds.
#: `0` means "one continuous utterance" -- the delivery this service had before
#: the setting existed, and therefore the right value when core-api says nothing.
DEFAULT_PAUSE_MS = 0

#: Accepted range, mirroring core-api's `TtsConfiguration` value object. Unlike
#: the speed/volume ranges (which `TtsSettings` owns, so this module must not
#: duplicate them), nothing downstream validates a pause: it is consumed as a
#: number of milliseconds by the finisher, where a negative value would produce
#: a malformed ffmpeg filter and a huge one would produce a clip nobody waits
#: through. So the bounds live here, at the point of entry.
MIN_PAUSE_MS = 0
MAX_PAUSE_MS = 2000


@dataclass(frozen=True)
class TtsConfig:
    """Resolved announcement settings."""

    engine: str
    settings: TtsSettings
    pause_ms: int = DEFAULT_PAUSE_MS

    @property
    def cache_parts(self) -> tuple[object, ...]:
        return (
            self.engine,
            self.settings.voice_id,
            self.settings.speed,
            self.settings.volume,
            self.pause_ms,
        )


#: What the service uses before core-api has a `ttsConfiguration` at all. Landing
#: this service before the admin-panel work means EVERY deployment starts here, so
#: the default must be a fully working configuration rather than a placeholder.
FALLBACK = TtsConfig(
    engine=DEFAULT_ENGINE,
    settings=TtsSettings(voice_id=DEFAULT_VOICE, speed=1.0, volume=1.0),
    pause_ms=DEFAULT_PAUSE_MS,
)


class CoreApiConfigClient:
    """TTL-cached reader for the announcement slice of the system config."""

    def __init__(
        self,
        base_url: str,
        *,
        ttl_seconds: float = 30.0,
        timeout_seconds: float = 3.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._ttl = ttl_seconds
        self._timeout = timeout_seconds
        self._lock = threading.Lock()
        self._cached: TtsConfig | None = None
        self._fetched_at = 0.0

    def resolve(self) -> TtsConfig:
        """Current config, refetched at most once per TTL.

        Never raises: core-api being briefly unreachable must not silence the
        board. A failed refresh keeps serving the last good config (or the
        fallback), and logs at warning level so the cause is discoverable.
        """
        now = time.monotonic()
        with self._lock:
            fresh = self._cached is not None and (now - self._fetched_at) < self._ttl
            if fresh:
                return self._cached  # type: ignore[return-value]

        fetched = self._fetch()
        with self._lock:
            if fetched is not None:
                self._cached = fetched
                self._fetched_at = now
            elif self._cached is None:
                # First fetch failed and we have nothing -- adopt the fallback but
                # do NOT stamp _fetched_at, so the next request retries instead of
                # waiting out the TTL on a value we never really got.
                return FALLBACK
            return self._cached or FALLBACK

    def _fetch(self) -> TtsConfig | None:
        url = f"{self._base_url}/api/system/config"
        try:
            with urllib.request.urlopen(url, timeout=self._timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as exc:
            logger.warning("could not read tts config from %s: %s", url, exc)
            return None
        return self._parse(body)

    @staticmethod
    def _parse(body: object) -> TtsConfig:
        """Project the config document onto announcement settings.

        Every field is optional and individually defaulted. core-api will not carry
        `ttsConfiguration` until the admin-panel change lands, and even afterwards
        a store configured by an older wizard will not have it -- so an absent or
        partial object is the normal case, not corruption.
        """
        raw = {}
        if isinstance(body, dict):
            candidate = body.get("ttsConfiguration")
            if isinstance(candidate, dict):
                raw = candidate

        engine = _clean_str(raw.get("engine"))
        voice = _clean_str(raw.get("voice"))
        try:
            settings = TtsSettings(
                voice_id=voice or DEFAULT_VOICE,
                speed=_numeric_or(raw.get("speed"), 1.0),
                volume=_numeric_or(raw.get("volume"), 1.0),
            )
        except ValueError as exc:
            # Out-of-range knobs are a misconfiguration, not a reason to go mute.
            logger.warning("invalid ttsConfiguration knobs (%s); using defaults", exc)
            settings = FALLBACK.settings
        return TtsConfig(
            engine=engine or DEFAULT_ENGINE,
            settings=settings,
            pause_ms=_pause_ms_or(raw.get("pauseMs"), DEFAULT_PAUSE_MS),
        )


def _clean_str(value: object) -> str:
    """Trim a config string, treating whitespace-only as absent.

    A voice id of `"   "` is not a voice. Accepting it would push a guaranteed
    `VoiceNotAvailableError` down to the first announcement, where it reads as a
    broken service rather than a typo in the config.
    """
    return value.strip() if isinstance(value, str) else ""


def _pause_ms_or(value: object, default: int) -> int:
    """Coerce the pause to a whole number of milliseconds inside the valid range.

    Clamps nothing and raises nothing: an out-of-range or non-integer pause falls
    back to the default, exactly like an absent one. A bad pause must not be able
    to silence the board, and unlike speed/volume there is no `TtsSettings`
    downstream to own the range -- so this is the only place it can be checked,
    which is also why it does the check itself rather than delegating like
    `_numeric_or`.

    An integral `float` is accepted: core-api's value object enforces an integer,
    but `400.0` in a hand-edited config is unambiguously 400 ms, and rejecting it
    would silently restore the old delivery for a value that is not actually
    wrong. A fractional one is still rejected -- that is a client bug, not a
    preference.

    `bool` is excluded first because it is an `int` in Python, and `True` is not
    a duration.
    """
    if isinstance(value, bool):
        return default
    if isinstance(value, float):
        if not value.is_integer():
            return default
        value = int(value)
    if not isinstance(value, int):
        return default
    if not MIN_PAUSE_MS <= value <= MAX_PAUSE_MS:
        logger.warning(
            "ttsConfiguration.pauseMs %s outside [%s, %s]; using %s",
            value,
            MIN_PAUSE_MS,
            MAX_PAUSE_MS,
            default,
        )
        return default
    return value


def _numeric_or(value: object, default: float) -> float:
    """Coerce a JSON number, falling back when the field is absent or not numeric.

    Deliberately does NOT range-check: `TtsSettings.__post_init__` owns the valid
    ranges for speed and volume, and duplicating them here would mean two places to
    change and a silent clamp instead of a loud rejection. `bool` is excluded first
    because it is an `int` in Python, and `True` is not a speed.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)
