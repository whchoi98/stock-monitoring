"""
스케줄러 루프 + 앱 팩토리(lifespan/정적 서빙) 테스트 - 실제 네트워크·AWS 호출 없음.
Scheduler loop and app factory (lifespan / static serving) tests - no real network or AWS call.

시간 관련 동작은 실제 sleep 없이 검증한다: 대기 간격 함수를 패치하고 stop 이벤트로 깨운다.
Timing behaviour is verified without real sleeps: the interval functions are patched and the
stop event is what wakes the loops.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Optional

import pytest
from fastapi.testclient import TestClient

from app import main
from app.api import deps
from app.core import config, market_hours, scheduler
from app.main import create_app
from app.services import market_data
from app.state import STATUS_DEGRADED, STATUS_OK

# 페이크 시가총액 (conftest FAKE_QUOTES의 심볼) / Fake market caps (symbols from conftest FAKE_QUOTES)
FAKE_CAPS = {"AAPL": 3.0e12, "005930.KS": 4.0e11}

# 기존 캐시 유지를 확인하기 위한 표식 값 / Sentinel used to prove an existing cache entry survives
SENTINEL = [{"symbol": "SENTINEL"}]

# 직전 정상 US 시세 (한 시장이 실패해도 overview가 이 값으로 계속 만들어진다)
# Last good US quotes: the overview keeps being built from these even when that market fails
LAST_GOOD_US = [
    {
        "symbol": "AAPL", "name": "Apple", "price": 100.0, "change": 1.0, "change_pct": 1.5,
        "volume": 1_000, "market": "us", "currency": "USD", "sector": "Technology", "market_cap": None,
    },
    {
        "symbol": "JPM", "name": "JPMorgan Chase", "price": 100.0, "change": 1.0, "change_pct": -0.5,
        "volume": 2_000, "market": "us", "currency": "USD", "sector": "Financial", "market_cap": None,
    },
]

# 루프 테스트에서 쓰는 짧은 대기(초) / Short wait used by the loop tests
TICK = 0.01
# 루프 테스트 상한(초) - 대기가 stop으로 깨지지 않으면 여기서 실패한다
# Upper bound for the loop tests: a wait that stop does not interrupt fails here
LOOP_TIMEOUT = 3.0

# 장중/휴장 판정용 고정 시각 / Fixed timestamps for open and closed markets
MONDAY_KR_OPEN = datetime(2026, 8, 3, 1, 0, tzinfo=timezone.utc)   # 월 10:00 KST
SATURDAY_CLOSED = datetime(2026, 8, 1, 1, 0, tzinfo=timezone.utc)  # 토요일 / Saturday


# ---------------------------------------------------------------------------
# 픽스처 / Fixtures
# ---------------------------------------------------------------------------

class FakeMarketCaps:
    """`market_data.fetch_market_caps` 페이크 (호출 기록 + 예외 주입) / Fake for `fetch_market_caps` (records calls, injects errors)."""

    def __init__(self) -> None:
        self.calls: list = []
        self.error: Optional[Exception] = None

    def __call__(self, symbols) -> dict:
        self.calls.append(list(symbols))
        if self.error is not None:
            raise self.error
        return dict(FAKE_CAPS)


@pytest.fixture(autouse=True)
def caps(monkeypatch) -> FakeMarketCaps:
    """시가총액 조회를 페이크로 교체 (autouse: 어떤 테스트도 실제 yfinance를 때리지 않는다)."""
    fake = FakeMarketCaps()
    monkeypatch.setattr(market_data, "fetch_market_caps", fake)
    return fake


class RecordingRefresh:
    """refresh_* 대체용 호출 카운터 (예외 주입 가능) / Call counter that stands in for refresh_* (can raise)."""

    def __init__(self, error: Optional[Exception] = None) -> None:
        self.count = 0
        self.error = error

    async def __call__(self, state) -> None:
        self.count += 1
        if self.error is not None:
            raise self.error


async def _run_loops_until(state, stop, delay: float = 0.1) -> None:
    """루프를 돌리고 delay 후 stop을 세팅 / Run the loops and set stop after `delay`."""
    async def stopper() -> None:
        await asyncio.sleep(delay)
        stop.set()

    await asyncio.wait_for(
        asyncio.gather(scheduler.run_loops(state, stop), stopper()),
        timeout=LOOP_TIMEOUT,
    )


# ---------------------------------------------------------------------------
# refresh_market
# ---------------------------------------------------------------------------

async def test_refresh_market_writes_three_keys_and_marks_yahoo_ok(state, services, l2):
    """한 번의 refresh_market이 quotes:us/quotes:kr/overview를 L1+L2에 채운다 / One refresh_market fills all three keys in L1 and L2."""
    await scheduler.refresh_market(state)

    for key in (deps.key_quotes("us"), deps.key_quotes("kr"), deps.KEY_OVERVIEW):
        assert state.cache.l1.get(key) is not None, key
        assert key in l2.store, key
    assert state.source_status["yahoo"] == STATUS_OK


async def test_refresh_market_overview_has_the_same_shape_as_the_route(state, services):
    """스케줄러가 쓰는 overview 페이로드는 라우트와 동일한 완전 페이로드 / The scheduler writes the same complete overview payload as the route."""
    await scheduler.refresh_market(state)

    overview, _as_of = state.cache.l1.get(deps.KEY_OVERVIEW)
    assert {"indices", "indicators", "summary", "sectors"} == set(overview)
    assert overview["indices"][0]["symbol"] == "^GSPC"
    assert {"us", "kr"} == set(overview["sectors"])
    assert overview["summary"]["us"]["advancing"] == 1
    # 시세를 먼저 캐시에 썼으므로 overview는 업스트림을 다시 때리지 않는다 (시장당 1회)
    # Quotes are cached first, so overview does not re-hit upstream (one fetch per market)
    assert services.calls["fetch_quotes"] == 2


async def test_refresh_market_fills_market_cap_once_per_window(state, services, caps):
    """시가총액은 10분에 한 번만 조회하고 그 사이 사이클도 값을 유지한다 / Market caps are fetched once per window and kept in between."""
    await scheduler.refresh_market(state)
    await scheduler.refresh_market(state)

    assert len(caps.calls) == 1
    assert "AAPL" in caps.calls[0]
    quotes, _as_of = state.cache.l1.get(deps.key_quotes("us"))
    assert quotes[0]["market_cap"] == FAKE_CAPS["AAPL"]
    kr_quotes, _as_of = state.cache.l1.get(deps.key_quotes("kr"))
    assert kr_quotes[0]["market_cap"] == FAKE_CAPS["005930.KS"]


async def test_refresh_market_keeps_cache_and_marks_degraded_on_failure(state, services):
    """시세 조회 실패 시 기존 캐시를 유지하고 degraded로 마킹한다 (예외 미전파) / On a quote failure the cache survives, yahoo goes degraded, nothing raises."""
    for key in (deps.key_quotes("us"), deps.key_quotes("kr"), deps.KEY_OVERVIEW):
        await state.cache.put(key, SENTINEL, config.L2_TTL)
    services.errors["fetch_quotes"] = RuntimeError("yahoo down")

    await scheduler.refresh_market(state)

    for key in (deps.key_quotes("us"), deps.key_quotes("kr"), deps.KEY_OVERVIEW):
        value, _as_of = state.cache.l1.get(key)
        assert value == SENTINEL, key
    assert state.source_status["yahoo"] == STATUS_DEGRADED


async def test_refresh_market_isolates_a_single_market_failure(state, services, l2, monkeypatch):
    """
    한 시장의 시세 실패가 다른 시장 쓰기와 overview 갱신을 죽이지 않는다.
    One market's quote failure kills neither the other market's write nor the overview refresh.

    `fetch_quotes`는 커버리지 미달/전체 공백에서 `QuotesUnavailableError`를 던진다. US가 던졌다고
    KR 테이블과 overview까지 최대 24시간 묵은 값으로 방치하면 한 시장의 장애가 화면 전체가 된다.
    `fetch_quotes` raises `QuotesUnavailableError` on low coverage or an all-empty market. If a US
    failure also froze the KR table and the overview at up to 24h-old values, one market's outage
    would become the whole screen's.
    """
    def us_down(market: str):
        """US만 던지고 KR은 정상 시세를 준다 / Only US raises; KR still returns quotes."""
        if market == "us":
            raise market_data.QuotesUnavailableError("no quotes for market 'us'")
        return services.fetch_quotes(market)

    # 직전 US 시세는 캐시에 남아 있다 (실패한 시장은 캐시를 건드리지 않는다)
    # The last good US quotes stay in the cache: a failed market's key is never touched
    await state.cache.put(deps.key_quotes("us"), LAST_GOOD_US, config.L2_TTL)
    monkeypatch.setattr(market_data, "fetch_quotes", us_down)

    await scheduler.refresh_market(state)

    kr_quotes, _as_of = state.cache.l1.get(deps.key_quotes("kr"))
    assert [q["symbol"] for q in kr_quotes] == ["005930.KS", "005380.KS"]
    assert deps.key_quotes("kr") in l2.store
    us_quotes, _as_of = state.cache.l1.get(deps.key_quotes("us"))
    assert us_quotes == LAST_GOOD_US
    # overview는 캐시에 있는 US 시세로라도 갱신된다 / the overview is still refreshed from cached US quotes
    overview, _as_of = state.cache.l1.get(deps.KEY_OVERVIEW)
    assert overview["summary"]["us"]["advancing"] == 1
    assert overview["summary"]["kr"]["advancing"] == 1
    assert deps.KEY_OVERVIEW in l2.store
    assert state.source_status["yahoo"] == STATUS_DEGRADED


async def test_refresh_market_marks_degraded_on_a_partial_market(state, services, l2, monkeypatch):
    """
    커버리지 100% 미달(부분 성공)도 degraded다 / A partial market (below full coverage) is degraded too.

    부분 결과는 캐시에 그대로 쓴다 — 마지막 정상값보다 최신이고, `fetch_quotes`의 커버리지 게이트가
    이미 하한을 지켰다. 감추는 대신 `/api/health`에 드러내야 30/50행 테이블이 초록으로 보이지 않는다.
    The partial rows are still written: they are newer than the last good value and `fetch_quotes`'
    coverage gate already enforced the floor. Surfacing it in `/api/health` is what keeps a 30-of-50-row
    table from looking green.
    """
    def partial(market: str):
        """US만 요청 심볼보다 적게 반환 / Only US returns fewer rows than it requested."""
        quotes = services.fetch_quotes(market)
        return quotes[:-1] if market == "us" else quotes

    monkeypatch.setattr(market_data, "fetch_quotes", partial)

    await scheduler.refresh_market(state)

    us_quotes, _as_of = state.cache.l1.get(deps.key_quotes("us"))
    assert len(us_quotes) == len(market_data.market_symbols("us")) - 1
    assert deps.key_quotes("us") in l2.store
    assert state.source_status["yahoo"] == STATUS_DEGRADED


async def test_refresh_market_skips_market_caps_when_no_quotes_arrived(state, services, caps, l2):
    """
    시세가 하나도 안 왔으면 시가총액 조회 자체를 건너뛴다 / With no quote at all, the cap lookup is skipped.

    빈 심볼 목록으로 조회하면 빈 맵이 10분 창(`MARKET_CAP_TTL`) 동안 캐시되어, 그 사이 회복된
    사이클의 `Quote.market_cap`이 계속 빈다.
    Looking up an empty symbol list would cache an empty map for the 10-minute window
    (`MARKET_CAP_TTL`), blanking `Quote.market_cap` on the cycles that recover in between.
    """
    services.errors["fetch_quotes"] = market_data.QuotesUnavailableError("both markets empty")

    await scheduler.refresh_market(state)

    assert caps.calls == []
    assert scheduler.KEY_MARKET_CAPS not in l2.store
    assert state.source_status["yahoo"] == STATUS_DEGRADED


async def test_refresh_market_survives_market_cap_failure(state, services, caps):
    """시가총액 실패는 시세 갱신을 막지 않는다 (보조 데이터) / A market-cap failure must not block the quote refresh."""
    caps.error = RuntimeError("fast_info down")

    await scheduler.refresh_market(state)

    quotes, _as_of = state.cache.l1.get(deps.key_quotes("us"))
    assert quotes[0]["market_cap"] is None
    assert state.cache.l1.get(deps.KEY_OVERVIEW) is not None
    assert state.source_status["yahoo"] == STATUS_OK


# ---------------------------------------------------------------------------
# refresh_news
# ---------------------------------------------------------------------------

async def test_refresh_news_writes_feed_key_and_marks_rss_ok(state, services, l2):
    """refresh_news는 news:feed를 채우고 rss를 ok로 마킹한다 / refresh_news fills news:feed and marks rss ok."""
    await scheduler.refresh_news(state)

    value, _as_of = state.cache.l1.get(deps.KEY_NEWS_FEED)
    assert value[0]["title"] == "Markets rally on earnings"
    assert deps.KEY_NEWS_FEED in l2.store
    assert state.source_status["rss"] == STATUS_OK


async def test_refresh_news_keeps_cache_and_marks_degraded_on_failure(state, services):
    """뉴스 실패 시 기존 피드를 유지하고 degraded로 마킹한다 / On a news failure the old feed survives and rss goes degraded."""
    await state.cache.put(deps.KEY_NEWS_FEED, SENTINEL, config.L2_TTL)
    services.errors["fetch_news"] = RuntimeError("rss down")

    await scheduler.refresh_news(state)

    value, _as_of = state.cache.l1.get(deps.KEY_NEWS_FEED)
    assert value == SENTINEL
    assert state.source_status["rss"] == STATUS_DEGRADED


# ---------------------------------------------------------------------------
# 대기 간격 / Wait intervals
# ---------------------------------------------------------------------------

def test_news_interval_is_120_while_open_and_600_when_closed():
    """뉴스 루프 간격: 장중 120초, 휴장 600초 / News loop interval: 120s while open, 600s when closed."""
    assert scheduler.news_interval(MONDAY_KR_OPEN) == config.NEWS_REFRESH_INTERVAL == 120
    assert scheduler.news_interval(SATURDAY_CLOSED) == config.CLOSED_REFRESH_INTERVAL == 600


# ---------------------------------------------------------------------------
# run_loops
# ---------------------------------------------------------------------------

async def test_run_loops_runs_both_loops_and_uses_market_hours_interval(state, monkeypatch):
    """두 루프가 반복 실행되고 market 루프는 refresh_interval(now)로 대기한다 / Both loops iterate; the market loop waits refresh_interval(now)."""
    market = RecordingRefresh()
    news = RecordingRefresh()
    intervals: list = []

    def fake_refresh_interval(now: datetime) -> float:
        intervals.append(now)
        return TICK

    monkeypatch.setattr(scheduler, "refresh_market", market)
    monkeypatch.setattr(scheduler, "refresh_news", news)
    monkeypatch.setattr(market_hours, "refresh_interval", fake_refresh_interval)
    monkeypatch.setattr(scheduler, "news_interval", lambda now: TICK)

    await _run_loops_until(state, asyncio.Event())

    assert market.count >= 2
    assert news.count >= 2
    assert intervals and all(isinstance(now, datetime) for now in intervals)


async def test_run_loops_wakes_immediately_when_stop_is_set(state, monkeypatch):
    """긴 대기 중에도 stop 이벤트가 즉시 두 루프를 깨운다 / The stop event wakes both loops at once, even mid-long-wait."""
    market = RecordingRefresh()
    news = RecordingRefresh()
    monkeypatch.setattr(scheduler, "refresh_market", market)
    monkeypatch.setattr(scheduler, "refresh_news", news)
    monkeypatch.setattr(market_hours, "refresh_interval", lambda now: 600)
    monkeypatch.setattr(scheduler, "news_interval", lambda now: 600)

    # 대기가 600초를 실제로 세면 LOOP_TIMEOUT에서 실패한다 / A real 600s wait fails at LOOP_TIMEOUT
    await _run_loops_until(state, asyncio.Event(), delay=0.05)

    assert market.count == 1
    assert news.count == 1


async def test_run_loops_survives_an_iteration_exception(state, monkeypatch):
    """한 사이클의 예외가 루프를 죽이지 않는다 (다른 루프도 무사) / One iteration's exception kills neither loop."""
    market = RecordingRefresh(error=RuntimeError("boom"))
    news = RecordingRefresh()
    monkeypatch.setattr(scheduler, "refresh_market", market)
    monkeypatch.setattr(scheduler, "refresh_news", news)
    monkeypatch.setattr(market_hours, "refresh_interval", lambda now: TICK)
    monkeypatch.setattr(scheduler, "news_interval", lambda now: TICK)

    await _run_loops_until(state, asyncio.Event())

    assert market.count >= 2
    assert news.count >= 2


# ---------------------------------------------------------------------------
# lifespan
# ---------------------------------------------------------------------------

class FakeRunLoops:
    """run_loops 대체 - 인자를 기록하고 stop까지 대기 / Stands in for run_loops: records its args and waits for stop."""

    def __init__(self) -> None:
        self.state = None
        self.stop = None

    async def __call__(self, state, stop) -> None:
        self.state = state
        self.stop = stop
        await stop.wait()


@pytest.fixture
def loops(monkeypatch) -> FakeRunLoops:
    fake = FakeRunLoops()
    monkeypatch.setattr(scheduler, "run_loops", fake)
    return fake


def test_lifespan_attaches_dynamo_l2_and_stops_loops_on_shutdown(state, loops, monkeypatch):
    """기동 시 L2를 붙이고 스케줄러를 띄우며, 종료 시 stop을 세팅한다 / Startup attaches L2 and starts the scheduler; shutdown sets stop."""
    fake_l2 = object()
    monkeypatch.setattr(main, "_build_l2", lambda table: fake_l2)

    with TestClient(create_app(state, background=True)) as client:
        assert client.get("/api/health").status_code == 200
        assert state.cache.l2 is fake_l2
        assert loops.state is state
        assert not loops.stop.is_set()

    assert loops.stop.is_set()


def test_lifespan_starts_without_l2_when_table_is_unreachable(state, l2, loops, monkeypatch):
    """CACHE_TABLE 접근 실패 시 L2 없이 기동한다 (로컬 개발 배려) / An unreachable CACHE_TABLE starts the app without L2."""
    def unreachable(table: str):
        raise RuntimeError("no credentials")

    monkeypatch.setattr(main, "_build_l2", unreachable)

    with TestClient(create_app(state, background=True)) as client:
        assert client.get("/api/health").status_code == 200
        assert state.cache.l2 is l2  # 기존 L2 유지 (교체 실패) / the existing L2 is untouched
        assert loops.state is state


# ---------------------------------------------------------------------------
# 정적 서빙 / Static serving
# ---------------------------------------------------------------------------

INDEX_HTML = "<!doctype html><title>spa</title>"


@pytest.fixture
def static_build(tmp_path, monkeypatch):
    """frontend 빌드 산출물을 흉내낸 정적 디렉터리 / A static directory standing in for the frontend build."""
    (tmp_path / "index.html").write_text(INDEX_HTML, encoding="utf-8")
    (tmp_path / "app.js").write_text("console.log(1)", encoding="utf-8")
    monkeypatch.setenv("STATIC_DIR", str(tmp_path))
    return tmp_path


def test_static_serving_returns_index_for_spa_routes(state, static_build):
    """/ 와 SPA 라우트는 index.html, 자산은 그대로 서빙 / `/` and SPA routes serve index.html; assets are served as-is."""
    client = TestClient(create_app(state))

    assert client.get("/").text == INDEX_HTML
    assert client.get("/stocks/AAPL").text == INDEX_HTML  # SPA 404 fallback
    assert client.get("/app.js").status_code == 200


def test_static_fallback_never_swallows_api_404(state, static_build):
    """/api 404는 index.html이 아니라 JSON 404를 유지한다 / An /api 404 stays a JSON 404, never index.html."""
    client = TestClient(create_app(state))

    response = client.get("/api/market/nope")
    assert response.status_code == 404
    assert response.json()["detail"]
    # GET/HEAD 외의 메서드는 SPA fallback 대상이 아니다 / Non GET/HEAD methods are not SPA routes
    assert client.post("/stocks/AAPL").status_code in (404, 405)


def test_static_serving_is_skipped_when_the_build_is_missing(state, tmp_path, monkeypatch):
    """빌드 산출물이 없으면 정적 서빙을 건너뛰고 API는 정상 동작 / Without a build the static mount is skipped and the API still works."""
    monkeypatch.setenv("STATIC_DIR", str(tmp_path / "absent"))
    client = TestClient(create_app(state))

    assert client.get("/").status_code == 404
    assert client.get("/api/health").status_code == 200
