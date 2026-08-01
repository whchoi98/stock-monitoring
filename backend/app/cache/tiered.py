import json
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional, Tuple

logger = logging.getLogger(__name__)


class TieredCache:
    """Tiered cache orchestration: L1 (memory) -> L2 (persistent) -> fetch -> L2 stale fallback."""

    def __init__(self, l1: Any, l2: Any):
        """
        Initialize tiered cache.

        Args:
            l1: L1 cache (MemoryCache)
            l2: L2 cache (duck-typed: must have async get, get_stale, put methods)
        """
        self.l1 = l1
        self.l2 = l2

    async def get_or_fetch(
        self,
        key: str,
        ttl: int,
        fetcher: Callable[[], Awaitable[Any]],
    ) -> Tuple[Any, str, str]:
        """
        Get value from tiered cache or fetch fresh data.

        Lookup order: L1 -> L2 -> fetch -> L2 stale fallback

        Args:
            key: Cache key
            ttl: Time to live in seconds
            fetcher: Async callable that returns fresh data

        Returns:
            Tuple of (value, asOf ISO8601 string, source)
            where source is one of: "l1", "l2", "fetch", "l2-stale"

        Raises:
            Exception: Original fetcher exception if fetch fails and no stale fallback available
        """
        # Try L1
        l1_result = self.l1.get(key)
        if l1_result is not None:
            value, as_of = l1_result
            return (value, as_of, "l1")

        # Try L2
        l2_result = await self.l2.get(key)
        if l2_result is not None:
            value, as_of = l2_result
            # Populate L1 from L2
            self.l1.set(key, value, ttl, as_of)
            return (value, as_of, "l2")

        # Try to fetch fresh data
        try:
            fresh_value = await fetcher()
            now_iso = datetime.now(timezone.utc).isoformat()
            # Write to both L1 and L2
            self.l1.set(key, fresh_value, ttl, now_iso)
            await self.l2.put(key, fresh_value, ttl, now_iso)
            return (fresh_value, now_iso, "fetch")
        except Exception as fetch_error:
            # Log the fetch failure as JSON
            error_log = {
                "event": "fetch_failed",
                "key": key,
                "error": str(fetch_error),
            }
            logger.warning(json.dumps(error_log))

            # Try L2 stale fallback (ignores TTL)
            l2_stale_result = await self.l2.get_stale(key)
            if l2_stale_result is not None:
                value, as_of = l2_stale_result
                return (value, as_of, "l2-stale")

            # No fallback available, re-raise original exception
            raise

    async def put(self, key: str, value: Any, ttl: int) -> None:
        """
        Proactively write to both L1 and L2 caches.

        Used by scheduler for pre-caching.

        Args:
            key: Cache key
            value: Value to cache
            ttl: Time to live in seconds
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        self.l1.set(key, value, ttl, now_iso)
        await self.l2.put(key, value, ttl, now_iso)
