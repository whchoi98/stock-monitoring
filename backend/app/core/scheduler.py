"""
백그라운드 스케줄러 - 선제 갱신 키(quotes/overview/news)를 주기적으로 다시 캐시에 쓴다.
Background scheduler - periodically re-writes the pre-warmed keys (quotes/overview/news) into the cache.

이 루프가 곧 응답의 신선도다: 해당 키들의 L1 TTL은 L2 보존용으로 24시간이라, 사이클이 멈추면
최대 24시간 묵은 값이 계속 신선한 것처럼 반환된다. 그래서 (1) 실패는 절대 조용히 넘기지 않고
(기존 캐시 유지 + `source_status` degraded + JSON 경고 로그), (2) 한 사이클의 예외가 루프를
죽이지 않는다.
These loops *are* the response freshness: those keys carry a 24h L1 TTL (they exist that long for L2's
sake), so a stalled cycle keeps serving up to 24h-old values as if they were fresh. Hence (1) a failure
is never silent (existing cache kept, `source_status` degraded, single-line JSON warning) and (2) one
iteration's exception never kills the loop.

페이로드는 라우트(B10)와 **같은** 빌더를 통해 만든다 - 스케줄러가 다른 형태를 쓰면 프론트가 깨진다.
Payloads are built through the *same* builders the routes use (B10); a different shape here would break
the frontend. That is why this core module imports from `app.api.market`.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List

from app.api import deps
from app.api import market as market_api
from app.core import config, market_hours
from app.services import market_data
from app.state import AppState, STATUS_DEGRADED, STATUS_OK

logger = logging.getLogger(__name__)

# 갱신 대상 시장 / Markets refreshed every cycle
MARKETS = ("us", "kr")

# 시가총액 캐시 키와 주기(초) - `fetch_market_caps`는 종목당 개별 호출이라 10분에 한 번만 돈다.
# 캐시에 담아두므로 그 사이 사이클도 같은 값으로 Quote.market_cap을 채울 수 있다.
# Market-cap cache key and window: `fetch_market_caps` is one call per symbol, so it runs once per
# 10 minutes; keeping the map in the cache lets the cycles in between fill Quote.market_cap too.
KEY_MARKET_CAPS = "market:caps"
MARKET_CAP_TTL = 600


def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


def _utc_now() -> datetime:
    """대기 간격 계산용 현재 시각 / Current time, used to pick the wait interval."""
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# 시가총액 / Market caps
# ---------------------------------------------------------------------------

def _apply_market_caps(quotes: List[dict], caps: Dict[str, float]) -> None:
    """시세 dict에 시가총액을 채운다 (제자리 수정) / Fill market_cap into the quote dicts, in place."""
    for quote in quotes:
        cap = caps.get(quote.get("symbol"))
        if cap:
            quote["market_cap"] = cap


async def _market_caps(state: AppState, symbols: List[str]) -> Dict[str, float]:
    """
    시가총액 맵을 캐시 경유로 조회 (10분 창 안에서는 재조회하지 않음).
    Read the market-cap map through the cache; no re-fetch inside the 10-minute window.

    실패는 경고만 남기고 빈 맵을 반환한다 - 시가총액은 보조 컬럼이라 시세 갱신을 막지 않는다.
    A failure only warns and yields an empty map: the cap is a secondary column and must not block
    the quote refresh (`source_status`는 시세 성공/실패만 반영한다).
    """
    async def fetch() -> Dict[str, float]:
        return await asyncio.to_thread(market_data.fetch_market_caps, symbols)

    try:
        caps, _as_of, _origin = await state.cache.get_or_fetch(KEY_MARKET_CAPS, MARKET_CAP_TTL, fetch)
    except Exception as exc:
        _warn("scheduler_market_caps_failed", error=str(exc))
        return {}
    return caps or {}


# ---------------------------------------------------------------------------
# 갱신 / Refresh
# ---------------------------------------------------------------------------

async def refresh_market(state: AppState) -> None:
    """
    `quotes:us` / `quotes:kr` / `overview`를 갱신하고 `source_status["yahoo"]`를 반영한다.
    Refresh `quotes:us`, `quotes:kr` and `overview`, then update `source_status["yahoo"]`.

    순서가 중요하다: 시세를 먼저 캐시에 쓴 뒤 overview를 만들어야 overview가 같은 사이클의
    시세를 본다 (`overview_payload`는 시세를 캐시에서 읽는다).
    Order matters: quotes are written first so `overview_payload` (which reads quotes from the cache)
    sees this cycle's numbers.

    시장별로 격리한다: `fetch_quotes`는 커버리지 미달/전체 공백에서 `QuotesUnavailableError`를
    던지므로(2026-08-04 장애 대응), 한 시장의 실패가 다른 시장 쓰기나 overview 갱신까지 건너뛰면
    한 시장의 장애가 화면 전체를 최대 24시간 묵은 값으로 얼려버린다.
    Isolated per market: `fetch_quotes` raises `QuotesUnavailableError` on low coverage or an
    all-empty market (post-2026-08-04), so letting one market's failure skip the other market's write
    or the overview refresh would freeze the whole screen at up to 24h-old values.

    예외는 전파하지 않는다. 실패한 부분은 캐시를 건드리지 않고(=직전 값 유지) degraded로 마킹한다.
    Nothing is raised: whatever failed leaves its cache entry alone (previous values keep serving) and
    the source is marked degraded.
    """
    quotes_by_market: Dict[str, List[dict]] = {}
    degraded = False

    # 1) 시장별 독립 조회 / Fetch each market independently
    for market in MARKETS:
        try:
            quotes_by_market[market] = await market_api.quotes_payload(market)
        except Exception as exc:
            degraded = True
            _warn("scheduler_market_quotes_failed", market=market, error=str(exc))

    # 2) 시가총액은 실제로 시세가 온 심볼만 조회 / Only look up caps for symbols that actually returned a quote
    #    심볼이 하나도 없으면 조회를 건너뛴다 — 빈 맵이 10분 창(MARKET_CAP_TTL) 동안 캐시되면
    #    회복된 사이클의 market_cap까지 빈 채로 남는다.
    #    Skipped entirely when no symbol arrived: an empty map cached for the 10-minute window
    #    (MARKET_CAP_TTL) would blank market_cap on the cycles that recover in between.
    symbols = [quote["symbol"] for quotes in quotes_by_market.values() for quote in quotes]
    caps = await _market_caps(state, symbols) if symbols else {}

    # 3) 조회에 성공한 시장만 캐시에 쓴다 (실패한 시장의 키는 직전 값 유지)
    #    Write only the markets that succeeded; a failed market's key keeps its previous value
    for market, quotes in quotes_by_market.items():
        try:
            _apply_market_caps(quotes, caps)
            await state.cache.put(deps.key_quotes(market), quotes, config.L2_TTL)
        except Exception as exc:
            degraded = True
            _warn("scheduler_market_write_failed", market=market, error=str(exc))

    # 4) overview는 캐시에 있는 값으로라도 갱신한다 (한 시장이 비어도 나머지는 최신)
    #    Refresh the overview from whatever is cached, so one empty market still leaves the rest fresh
    try:
        overview = await market_api.overview_payload(state)
        await state.cache.put(deps.KEY_OVERVIEW, overview, config.L2_TTL)
    except Exception as exc:
        degraded = True
        _warn("scheduler_overview_refresh_failed", error=str(exc))

    state.mark_source(deps.SOURCE_YAHOO, STATUS_DEGRADED if degraded else STATUS_OK)


async def refresh_news(state: AppState) -> None:
    """
    `news:feed`를 갱신하고 `source_status["rss"]`를 반영한다 / Refresh `news:feed` and update `source_status["rss"]`.

    `refresh_market`과 동일한 실패 규약: 예외 미전파 + 기존 캐시 유지 + degraded 마킹.
    Same failure contract as `refresh_market`: nothing raised, existing cache kept, source degraded.
    """
    try:
        feed = await market_api.news_payload()
        await state.cache.put(deps.KEY_NEWS_FEED, feed, config.L2_TTL)
    except Exception as exc:
        state.mark_source(deps.SOURCE_RSS, STATUS_DEGRADED)
        _warn("scheduler_news_refresh_failed", error=str(exc))
        return

    state.mark_source(deps.SOURCE_RSS, STATUS_OK)


# ---------------------------------------------------------------------------
# 루프 / Loops
# ---------------------------------------------------------------------------

def news_interval(now: datetime) -> int:
    """뉴스 루프 대기(초): 장중 120, 휴장 600 / News loop wait in seconds: 120 while open, 600 when closed."""
    if market_hours.any_market_open(now):
        return config.NEWS_REFRESH_INTERVAL
    return config.CLOSED_REFRESH_INTERVAL


async def _sleep_or_stop(stop: asyncio.Event, delay: float) -> None:
    """
    delay초 대기하되 stop이 세팅되면 즉시 깨어난다 / Wait `delay` seconds, waking at once if stop is set.

    `asyncio.sleep`을 쓰면 종료가 최대 한 주기(600초)까지 늦어진다.
    A plain `asyncio.sleep` would delay shutdown by up to a full cycle (600s).
    """
    try:
        await asyncio.wait_for(stop.wait(), timeout=delay)
    except asyncio.TimeoutError:
        pass


async def _loop(
    name: str,
    state: AppState,
    stop: asyncio.Event,
    refresh: Callable[[AppState], Awaitable[None]],
    interval: Callable[[datetime], float],
) -> None:
    """
    한 루프: 갱신 → 대기 → 반복 (stop까지) / One loop: refresh, wait, repeat until stop.

    `refresh`는 이미 자체적으로 예외를 삼키지만, 여기서 한 번 더 막는다 - 루프가 죽으면
    최대 24시간 묵은 캐시가 계속 신선한 것처럼 반환된다.
    `refresh` already swallows its own exceptions; this is the second guard, because a dead loop
    means up to 24h-stale cache being served as fresh.
    """
    while not stop.is_set():
        try:
            await refresh(state)
        except Exception as exc:
            _warn("scheduler_iteration_failed", loop=name, error=str(exc))
        await _sleep_or_stop(stop, interval(_utc_now()))


async def run_loops(state: AppState, stop: asyncio.Event) -> None:
    """
    market/news 두 루프를 함께 실행 / Run the market and news loops together.

    Args:
        state: 앱 컨텍스트 (캐시 + 소스 상태) / App context (cache and source status).
        stop: 종료 신호 - 실행 중인 이벤트 루프 안에서 생성해야 한다 (py3.9 loop 바인딩).
            Shutdown signal; it must be created inside the running event loop (py3.9 loop binding).
    """
    await asyncio.gather(
        _loop("market", state, stop, refresh_market, market_hours.refresh_interval),
        _loop("news", state, stop, refresh_news, news_interval),
    )
