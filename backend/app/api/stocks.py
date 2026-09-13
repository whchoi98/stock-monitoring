"""
종목 라우트 - 상세/차트/종목뉴스 + 시뮬레이션 호가·수급.
Stock routes - detail, chart, per-symbol news, plus the simulated order book and investor flows.

심볼은 캐시 키를 만들기 전에 `deps.resolve_symbol`로 검증·정규화한다 (유니버스 밖은 404).
Symbols pass `deps.resolve_symbol` before any cache key exists (404 outside the universe).

`detail:{symbol}` 캐시는 **느린 펀더멘털**(PER/EPS/베타/PBR/52주/시총/섹터/기간수익률)만 신뢰한다.
가격 계열 필드는 요청 시점에 `quotes:{market}`(45초 주기 갱신) 캐시에서 덮어쓴다 -
그래야 대시보드 테이블과 상세 헤더·호가가 같은 가격을 보여준다.
The `detail:{symbol}` cache is trusted for slow fundamentals only (ratios, 52-week range, market cap,
sector, period returns). Price-like fields are overlaid at request time from the `quotes:{market}`
cache (refreshed every 45s) so the dashboard table, the detail header and the order book agree.

호가·수급은 실데이터가 아니므로 응답 data에 반드시 `"simulated": true`를 담는다.
The order book and investor flows are not real data, so the response data always carries `"simulated": true`.
"""
from __future__ import annotations

import asyncio
from typing import Literal, Optional, Tuple

from fastapi import APIRouter, Depends

from app.api import deps
from app.core import config
from app.models import envelope
from app.services import charts, fundamentals, news, simulation
from app.state import AppState

router = APIRouter(prefix="/api/stocks", tags=["stocks"])

# 차트 기간 - CHART_TTL 키와 동일해야 한다 (테스트가 일치를 검증한다).
# 다른 값은 FastAPI가 422로 거절하므로 `fetch_chart`의 ValueError까지 도달하지 않는다.
# Chart periods, kept identical to the CHART_TTL keys (a test asserts the match). Any other value is
# rejected by FastAPI with 422, so `fetch_chart`'s ValueError is never reached from here.
Period = Literal["1w", "1m", "3m", "6m", "1y", "5y"]
DEFAULT_PERIOD = "1m"

# 수급: 일봉 차트에서 최근 10일을 쓴다 / Investor flows: the last 10 rows of the daily chart
INVESTOR_PERIOD = "1m"
INVESTOR_DAYS = 10

# 상세 응답에서 실시간 시세로 덮어쓰는 필드 / Detail fields overlaid from the live quote
LIVE_PRICE_FIELDS = ("price", "change", "change_pct", "volume")


# ---------------------------------------------------------------------------
# 캐시 경유 조회 / Cached fetches
# ---------------------------------------------------------------------------

async def detail_payload(symbol: str) -> dict | deps.Partial:
    """종목 상세를 dict로 (동기 서비스는 to_thread) / Stock detail as a dict (sync service via to_thread)."""
    detail = await asyncio.to_thread(fundamentals.fetch_detail, symbol)
    payload = detail.model_dump(mode="json")
    if detail._source_failures:
        return deps.Partial(payload, {"symbol": symbol, "failures": detail._source_failures})
    return payload


async def cached_detail(state: AppState, symbol: str) -> Tuple[dict, str]:
    """`detail:{symbol}` 키로 상세 조회 / Read the detail through the `detail:{symbol}` key."""
    return await deps.cached(
        state,
        deps.key_detail(symbol),
        config.FUNDAMENTALS_TTL,
        lambda: detail_payload(symbol),
        deps.SOURCE_YAHOO,
    )


async def chart_payload(symbol: str, period: str) -> dict:
    """차트를 dict로 (동기 서비스는 to_thread) / Chart as a dict (sync service via to_thread)."""
    chart = await asyncio.to_thread(charts.fetch_chart, symbol, period)
    return chart.model_dump(mode="json")


async def cached_chart(state: AppState, symbol: str, period: str) -> Tuple[dict, str]:
    """`chart:{symbol}:{period}` 키로 차트 조회 / Read the chart through the `chart:{symbol}:{period}` key."""
    return await deps.cached(
        state,
        deps.key_chart(symbol, period),
        config.CHART_TTL[period],
        lambda: chart_payload(symbol, period),
        deps.SOURCE_YAHOO,
    )


# ---------------------------------------------------------------------------
# 실시간 가격 오버레이 / Live price overlay
# ---------------------------------------------------------------------------

def live_quote(state: AppState, symbol: str) -> Optional[Tuple[dict, str]]:
    """
    `quotes:{market}` L1 캐시에서 해당 종목 시세를 읽는다 / Read the symbol's quote from the `quotes:{market}` L1 cache.

    L1만 본다: 상세 요청이 시장 전체 시세 조회(50종목)를 유발해서는 안 된다.
    캐시가 없거나 종목이 없으면 None -> 호출부는 캐시된 상세의 가격으로 폴백한다 (오류 아님).
    L1 only: a detail request must never trigger a full 50-symbol quotes fetch. A missing cache or
    a missing symbol yields None, and the caller falls back to the cached detail's own price (not an error).

    Returns:
        (시세 dict, asOf) 또는 None / (quote dict, asOf) or None.
    """
    entry = state.cache.l1.get(deps.key_quotes(deps.market_of(symbol)))
    if entry is None:
        return None
    quotes, as_of = entry
    for quote in quotes or []:
        if isinstance(quote, dict) and quote.get("symbol") == symbol:
            return quote, as_of
    return None


def overlay_live_price(detail: dict, quote: Optional[dict]) -> dict:
    """
    느린 펀더멘털 캐시 위에 실시간 가격을 덮어쓴다 / Overlay the live price on top of the slow fundamentals cache.

    `day_change`/`day_change_pct`는 `change`/`change_pct`의 미러 필드(TUI 호환)이므로 함께 갱신해
    한 응답 안에서 값이 어긋나지 않게 한다.
    `day_change`/`day_change_pct` mirror `change`/`change_pct` (TUI compatibility) and are updated with
    them so a single response never contradicts itself.
    전일종가도 시세의 현재가−등락금액으로 맞춘다. 12시간 캐시의 전일종가는 다른 거래일일 수 있다.
    Previous close also follows the quote's price minus change; the 12h cache may refer to another session.

    Args:
        detail: 캐시된 상세 dict / The cached detail dict.
        quote: 실시간 시세 dict 또는 None / The live quote dict, or None.

    Returns:
        새 dict (입력은 변경하지 않는다 - 캐시된 값이므로) / A new dict; the input is never mutated (it is the cached value).
    """
    if quote is None:
        return detail

    merged = dict(detail)
    for field in LIVE_PRICE_FIELDS:
        value = quote.get(field)
        if value is not None:
            merged[field] = value
    if quote.get("price") is not None and quote.get("change") is not None:
        merged["prev_close"] = quote["price"] - quote["change"]
    merged["day_change"] = merged.get("change")
    merged["day_change_pct"] = merged.get("change_pct")
    return merged


async def detail_view(state: AppState, symbol: str) -> Tuple[dict, str]:
    """
    상세 응답 데이터 조립 - 느린 펀더멘털(12h 캐시) + 실시간 가격(45초 캐시).
    Build the detail response data: slow fundamentals (12h cache) plus the live price (45s cache).

    Returns:
        (상세 dict, asOf) - 실시간 시세를 덮어썼다면 asOf는 그 시세의 시각(가격이 응답의 대표 데이터).
        (detail dict, asOf); when the live quote was applied, asOf is the quote's timestamp because the
        price is the headline datum of the response.
    """
    detail, as_of = await cached_detail(state, symbol)
    live = live_quote(state, symbol)
    if live is None:
        return detail, as_of
    quote, quote_as_of = live
    return overlay_live_price(detail, quote), quote_as_of


async def company_news_payload(symbol: str) -> list:
    """종목 뉴스를 dict 리스트로 (서비스가 이미 async) / Per-symbol news as dicts (the service is already async)."""
    items = await news.fetch_company_news(symbol)
    return [item.model_dump(mode="json") for item in items]


# ---------------------------------------------------------------------------
# 라우트 / Routes
# ---------------------------------------------------------------------------

@router.get("/{symbol}")
async def get_detail(
    symbol: str = Depends(deps.resolve_symbol),
    state: AppState = Depends(deps.get_state),
) -> dict:
    """상세 헤더 + 핵심지표 + 52주 범위 + 기간수익률 / Detail header, key ratios, 52-week range and period returns."""
    data, as_of = await detail_view(state, symbol)
    return envelope(data, deps.market_open_now(deps.market_of(symbol)), as_of)


@router.get("/{symbol}/chart")
async def get_chart(
    period: Period = DEFAULT_PERIOD,
    symbol: str = Depends(deps.resolve_symbol),
    state: AppState = Depends(deps.get_state),
) -> dict:
    """OHLCV + MA5/MA20 + 골든/데드 크로스 / OHLCV plus MA5/MA20 and golden/dead cross signals."""
    data, as_of = await cached_chart(state, symbol, period)
    return envelope(data, deps.market_open_now(deps.market_of(symbol)), as_of)


@router.get("/{symbol}/news")
async def get_stock_news(
    symbol: str = Depends(deps.resolve_symbol),
    state: AppState = Depends(deps.get_state),
) -> dict:
    """종목 뉴스 최대 8건 / At most eight per-symbol news items."""
    data, as_of = await deps.cached(
        state,
        deps.key_news(symbol),
        config.L2_TTL,
        lambda: company_news_payload(symbol),
        deps.SOURCE_RSS,
    )
    return envelope(data, deps.market_open_now(deps.market_of(symbol)), as_of)


@router.get("/{symbol}/orderbook")
async def get_orderbook(
    symbol: str = Depends(deps.resolve_symbol),
    state: AppState = Depends(deps.get_state),
) -> dict:
    """
    현재가 기반 호가 시뮬레이션 (실제 호가 아님) / Order book simulated from the current price (not real depth).

    가격·시드는 실시간 시세(45초 캐시)에서 나온다 - 12시간 캐시된 상세 가격을 쓰면 호가가 얼어붙는다.
    같은 현재가는 항상 같은 호가를 만든다 (시드 = 현재가 x 100).
    The price and the seed come from the live quote (45s cache); seeding from the 12h detail price would
    freeze the book. A given price always yields the same book (seed = price x 100).
    """
    detail, as_of = await detail_view(state, symbol)
    price = float(detail.get("price") or 0.0)
    market = detail.get("market") or deps.market_of(symbol)
    entries = simulation.build_order_book(price, market, seed=int(price * 100))
    data = {
        "symbol": symbol,
        "market": market,
        "price": price,
        "entries": [entry.model_dump(mode="json") for entry in entries],
        "simulated": True,
    }
    return envelope(data, deps.market_open_now(deps.market_of(symbol)), as_of)


@router.get("/{symbol}/investors")
async def get_investors(
    symbol: str = Depends(deps.resolve_symbol),
    state: AppState = Depends(deps.get_state),
) -> dict:
    """
    일봉 거래량·종가 방향에서 파생한 수급 시뮬레이션 10일 (실데이터 아님).
    Ten days of investor flows derived from daily volume and close direction (not real data).

    11일치를 넘기고 첫 행을 버린다: `build_investor_trends`의 첫 행은 비교할 전일 종가가 없어
    항상 상승으로 취급되므로, 반환되는 10일 전부가 올바른 방향을 갖게 한다.
    Eleven rows go in and the first result is dropped: `build_investor_trends` treats its first row as
    "up" for lack of a previous close, so every one of the ten returned days gets a correct direction.
    """
    chart, as_of = await cached_chart(state, symbol, INVESTOR_PERIOD)
    market = deps.market_of(symbol)
    history = [
        (candle["time"], candle["close"], candle["volume"])
        for candle in chart.get("candles", [])
    ][-(INVESTOR_DAYS + 1):]
    rows = simulation.build_investor_trends(history, market)[-INVESTOR_DAYS:]
    data = {
        "symbol": symbol,
        "market": market,
        "rows": [row.model_dump(mode="json") for row in rows],
        "simulated": True,
    }
    return envelope(data, deps.market_open_now(deps.market_of(symbol)), as_of)
