import asyncio

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


async def test_concurrent_same_key_fetches_once(cache):
    """Concurrent callers of the same cold key must trigger exactly one fetch."""
    calls = []

    async def fetcher():
        calls.append(1)
        await asyncio.sleep(0.01)
        return "fresh"

    results = await asyncio.gather(
        *(cache.get_or_fetch("k", 60, fetcher) for _ in range(5))
    )

    assert len(calls) == 1
    values = [v for v, _, _ in results]
    as_ofs = [as_of for _, as_of, _ in results]
    sources = [s for _, _, s in results]
    assert values == ["fresh"] * 5
    assert len(set(as_ofs)) == 1
    assert sources.count("fetch") == 1
    assert sources.count("l1") == 4


async def test_key_lock_entries_do_not_outlive_the_fetch(cache):
    """
    The lock map must not retain a key once nobody is fetching it.

    Not every key comes from a finite universe: `ai:article:{sha1(url)}` is derived from a
    client-supplied URL, so retaining one lock per key ever seen would be an unbounded leak.
    """
    async def fetcher():
        return "v"

    await cache.get_or_fetch("k", 60, fetcher)
    assert cache._locks == {}

    # A cache hit takes no lock at all, and a failing fetch must not leave one behind either
    await cache.get_or_fetch("k", 60, fetcher)
    assert cache._locks == {}

    async def boom():
        raise RuntimeError("upstream down")

    with pytest.raises(RuntimeError):
        await cache.get_or_fetch("cold", 60, boom)
    assert cache._locks == {}


async def test_concurrent_callers_share_one_lock_entry_then_release_it(cache):
    """Callers queued on one key share a single entry (single flight) which is dropped afterwards."""
    entries_while_in_flight = []

    async def fetcher():
        entries_while_in_flight.append(len(cache._locks))
        await asyncio.sleep(0.01)
        return "fresh"

    await asyncio.gather(*(cache.get_or_fetch("k", 60, fetcher) for _ in range(5)))

    assert entries_while_in_flight == [1]  # one fetch, one shared entry
    assert cache._locks == {}


def test_l1_reclaims_expired_write_once_keys_on_later_writes(monkeypatch):
    """
    Expired entries must be reclaimed even if their key is never read again.

    `get` expires lazily per key, so a write-once key (an AI article analysis, keyed by a client
    URL) would stay in the store forever. Writes sweep instead.
    """
    monkeypatch.setattr(MemoryCache, "SWEEP_INTERVAL_SEC", 0)  # sweep on every write
    l1 = MemoryCache()
    as_of = "2026-08-01T00:00:00Z"

    l1.set("live", "v", 300, as_of)
    l1.set("write-once", "v", 0, as_of)  # TTL already elapsed, never read again
    l1.set("later", "v", 300, as_of)

    assert sorted(l1.store) == ["later", "live"]


async def test_peek_returns_an_l1_hit(cache):
    """peek은 L1 히트를 값+asOf로 돌려준다 / peek returns an L1 hit as (value, asOf)."""
    cache.l1.set("k", "warm", 60, "2026-08-01T00:00:00Z")

    assert await cache.peek("k", 60) == ("warm", "2026-08-01T00:00:00Z")


async def test_peek_promotes_an_l2_hit_into_l1(cache):
    """L1 미스·L2 히트는 값을 돌려주고 L1으로 승격된다 / An L2 hit is returned and promoted into L1."""
    await cache.l2.put("k", "from-l2", 60, "2026-08-01T00:00:00Z")

    assert await cache.peek("k", 60) == ("from-l2", "2026-08-01T00:00:00Z")
    assert cache.l1.get("k") == ("from-l2", "2026-08-01T00:00:00Z")


async def test_peek_returns_none_when_both_tiers_miss(cache):
    """양쪽 미스는 None (예외도 stale 폴백도 없다) / A full miss is None: no error, no stale fallback."""
    assert await cache.peek("cold", 60) is None


async def test_peek_never_fetches_and_leaves_no_lock(cache):
    """
    peek은 업스트림을 부르지 않고 락도 남기지 않는다 / peek never fetches upstream and leaves no lock.

    SSE 라우트가 "히트면 final 하나"를 판단하는 프로브라서 미스가 곧 생성 트리거가 되면 안 된다 —
    생성은 라우트의 inflight 레지스트리가 선점자 하나에게만 맡긴다.
    It is the probe the SSE route uses to decide "a hit means one final event", so a miss must not
    trigger generation: the route's in-flight registry hands that to a single leader.
    """
    assert await cache.peek("cold", 60) is None
    assert cache.l1.store == {} and cache.l2.store == {}
    assert cache._locks == {}

    calls = []

    async def fetcher():
        calls.append(1)
        return "fresh"

    # 미스를 캐시하지 않았다는 증거: 뒤이은 get_or_fetch가 여전히 한 번 fetch한다
    # Proof that the miss was not cached: the following get_or_fetch still fetches exactly once
    value, _as_of, source = await cache.get_or_fetch("cold", 60, fetcher)
    assert (value, source, calls) == ("fresh", "fetch", [1])


async def test_concurrent_distinct_keys_are_not_serialized(cache):
    """Distinct keys must not block each other: each key fetches independently."""
    calls = []

    def make_fetcher(name):
        async def fetcher():
            calls.append(name)
            await asyncio.sleep(0.01)
            return name

        return fetcher

    results = await asyncio.gather(
        *(cache.get_or_fetch(k, 60, make_fetcher(k)) for k in ("a", "b", "c"))
    )

    assert sorted(calls) == ["a", "b", "c"]
    assert [(v, s) for v, _, s in results] == [
        ("a", "fetch"),
        ("b", "fetch"),
        ("c", "fetch"),
    ]
