import pytest
from app.cache.memory import MemoryCache
from app.cache.tiered import TieredCache


class FakeL2:
    def __init__(self):
        self.store = {}
        self.stale = {}

    async def get(self, key):
        return self.store.get(key)

    async def get_stale(self, key):
        return self.stale.get(key) or self.store.get(key)

    async def put(self, key, value, ttl, as_of):
        self.store[key] = (value, as_of)


@pytest.fixture
def cache():
    return TieredCache(MemoryCache(), FakeL2())


async def test_l1_hit_skips_fetch(cache):
    calls = []

    async def fetcher():
        calls.append(1)
        return "fresh"

    v1, _, s1 = await cache.get_or_fetch("k", 60, fetcher)
    v2, _, s2 = await cache.get_or_fetch("k", 60, fetcher)
    assert (v1, s1) == ("fresh", "fetch") and (v2, s2) == ("fresh", "l1") and len(calls) == 1


async def test_l2_hit_populates_l1(cache):
    await cache.l2.put("k", "from-l2", 60, "2026-08-01T00:00:00Z")

    async def fetcher():
        raise AssertionError("must not fetch")

    v, as_of, s = await cache.get_or_fetch("k", 60, fetcher)
    assert (v, s) == ("from-l2", "l2")
    assert cache.l1.get("k") is not None


async def test_fetch_writes_both(cache):
    async def fetcher():
        return {"a": 1}

    await cache.get_or_fetch("k", 60, fetcher)
    assert (await cache.l2.get("k"))[0] == {"a": 1}


async def test_fetch_failure_falls_back_to_stale(cache):
    cache.l2.stale["k"] = ("stale-data", "2026-07-31T00:00:00Z")

    async def fetcher():
        raise RuntimeError("yahoo down")

    v, as_of, s = await cache.get_or_fetch("k", 60, fetcher)
    assert (v, s) == ("stale-data", "l2-stale")
