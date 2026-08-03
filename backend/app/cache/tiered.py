import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Awaitable, Callable, Optional, Tuple

logger = logging.getLogger(__name__)


class _KeyLock:
    """A per-key lock plus the number of callers holding or waiting for it."""

    __slots__ = ("lock", "users")

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.users = 0


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
        # Per-key locks so concurrent callers of the same cold key trigger only one
        # upstream fetch. An entry lives only while a call holds or waits for that key
        # (see `_key_lock`), so the map is bounded by the number of in-flight fetches
        # rather than by the number of distinct keys ever seen. The distinction matters
        # because not every key comes from a finite universe: the AI routes derive
        # `ai:article:{sha1(url)}` from a client-supplied URL.
        self._locks: dict[str, _KeyLock] = {}

    @asynccontextmanager
    async def _key_lock(self, key: str) -> AsyncIterator[None]:
        """
        Hold the lock for one key, dropping the entry once nobody is using it.

        Every caller registers (`users += 1`) before awaiting the lock, so all callers
        queued on a key share one entry and the last one to leave removes it. The counter
        is never touched across an await, so the event loop cannot interleave two updates.
        """
        entry = self._locks.get(key)
        if entry is None:
            entry = _KeyLock()
            self._locks[key] = entry
        entry.users += 1
        try:
            async with entry.lock:
                yield
        finally:
            entry.users -= 1
            if entry.users <= 0:
                self._locks.pop(key, None)

    async def get_or_fetch(
        self,
        key: str,
        ttl: int,
        fetcher: Callable[[], Awaitable[Any]],
    ) -> Tuple[Any, str, str]:
        """
        Get value from tiered cache or fetch fresh data.

        Lookup order: L1 -> L2 -> fetch -> L2 stale fallback

        Concurrent callers for the same key are suppressed by a per-key lock: only
        one of them runs the L2/fetch path, the others wait and then hit the L1
        entry it wrote ("l1"). Locks are per key, so unrelated keys never serialize.

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
        # Try L1 without taking the lock (fast path for warm keys)
        l1_result = self.l1.get(key)
        if l1_result is not None:
            value, as_of = l1_result
            return (value, as_of, "l1")

        async with self._key_lock(key):
            # Double-checked: a concurrent caller may have populated L1 while we waited
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

    async def peek(self, key: str, ttl: int) -> Optional[Tuple[Any, str]]:
        """
        Probe the cache without fetching: L1 -> L2 (promoting an L2 hit into L1), else None.

        This is `get_or_fetch`'s lookup half with no fetch, no stale fallback and no key lock.
        The SSE AI routes use it to decide "a hit means one `final` event": a miss must therefore
        not trigger generation, and the race between concurrent missers is resolved by the route's
        own in-flight registry (one leader streams, the others follow its future), so taking the
        per-key lock here would only serialize probes without adding a guarantee.

        `ttl` is required for the same reason `get_or_fetch` takes one: promoting an L2 hit writes
        an L1 entry, and only the caller knows how long that entry may live (the AI routes pass
        `config.AI_TTL`).

        Args:
            key: Cache key
            ttl: Time to live in seconds applied to an L1 promotion

        Returns:
            Tuple of (value, asOf ISO8601 string) on a hit, None when both tiers miss.
        """
        l1_result = self.l1.get(key)
        if l1_result is not None:
            value, as_of = l1_result
            return (value, as_of)

        l2_result = await self.l2.get(key)
        if l2_result is not None:
            value, as_of = l2_result
            # Populate L1 from L2 (same promotion `get_or_fetch` performs)
            self.l1.set(key, value, ttl, as_of)
            return (value, as_of)

        return None

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
