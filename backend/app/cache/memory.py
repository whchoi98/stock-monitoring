import time
from typing import Any, Optional, Tuple


class MemoryCache:
    """In-memory cache with TTL support using monotonic time for expiry tracking."""

    # An expired entry is otherwise noticed only when its own key is read again, so a key
    # written once and never re-read would be held for the process lifetime. Some keys are
    # derived from client input (`ai:article:{sha1(url)}` in the AI routes), which would make
    # that an unbounded leak, so writes sweep the store periodically: what it holds is bounded
    # by the keys still inside their TTL, whether or not anyone reads them again.
    SWEEP_INTERVAL_SEC = 300

    def __init__(self):
        self.store: dict[str, tuple[Any, str, float]] = {}  # key -> (value, as_of, expires_at)
        self._next_sweep = time.monotonic() + self.SWEEP_INTERVAL_SEC

    def get(self, key: str) -> Optional[Tuple[Any, str]]:
        """
        Get value from cache if not expired.

        Args:
            key: Cache key

        Returns:
            Tuple of (value, as_of) if key exists and not expired, None otherwise
        """
        if key not in self.store:
            return None

        value, as_of, expires_at = self.store[key]

        # Lazy expiry check using monotonic time
        if time.monotonic() >= expires_at:
            del self.store[key]
            return None

        return (value, as_of)

    def set(self, key: str, value: Any, ttl: int, as_of: str) -> None:
        """
        Set value in cache with TTL.

        Args:
            key: Cache key
            value: Value to cache
            ttl: Time to live in seconds
            as_of: ISO8601 timestamp string
        """
        now = time.monotonic()
        self.store[key] = (value, as_of, now + ttl)
        if now >= self._next_sweep:
            self._sweep(now)

    def _sweep(self, now: float) -> None:
        """Drop every expired entry, at most once per SWEEP_INTERVAL_SEC (called on writes)."""
        self._next_sweep = now + self.SWEEP_INTERVAL_SEC
        expired = [key for key, (_value, _as_of, expires_at) in self.store.items() if now >= expires_at]
        for key in expired:
            del self.store[key]
