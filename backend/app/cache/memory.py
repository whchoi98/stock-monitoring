import time
from typing import Any, Optional, Tuple


class MemoryCache:
    """In-memory cache with TTL support using monotonic time for expiry tracking."""

    def __init__(self):
        self.store: dict[str, tuple[Any, str, float]] = {}  # key -> (value, as_of, expires_at)

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
        expires_at = time.monotonic() + ttl
        self.store[key] = (value, as_of, expires_at)
