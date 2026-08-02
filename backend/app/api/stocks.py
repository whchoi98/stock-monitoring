"""
종목 라우트 - 상세/차트/종목뉴스 + 시뮬레이션 호가·수급.
Stock routes - detail, chart, per-symbol news, plus the simulated order book and investor flows.

심볼은 캐시 키를 만들기 전에 `deps.resolve_symbol`로 검증·정규화한다 (유니버스 밖은 404).
Symbols pass `deps.resolve_symbol` before any cache key exists (404 outside the universe).

호가·수급은 실데이터가 아니므로 응답 data에 반드시 `"simulated": true`를 담는다.
The order book and investor flows are not real data, so the response data always carries `"simulated": true`.
"""
from __future__ import annotations

import asyncio
from typing import Literal, Tuple

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
Period = Literal["1w", "1m", "3m", "1y"]
DEFAULT_PERIOD = "1m"

# 수급: 일봉 차트에서 최근 10일을 쓴다 / Investor flows: the last 10 rows of the daily chart
INVESTOR_PERIOD = "1m"
INVESTOR_DAYS = 10


# ---------------------------------------------------------------------------
# 캐시 경유 조회 / Cached fetches
# ---------------------------------------------------------------------------

async def detail_payload(symbol: str) -> dict:
    """종목 상세를 dict로 (동기 서비스는 to_thread) / Stock detail as a dict (sync service via to_thread)."""
    detail = await asyncio.to_thread(fundamentals.fetch_detail, symbol)
    return detail.model_dump(mode="json")


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
    data, as_of = await cached_detail(state, symbol)
    return envelope(data, deps.market_open_now(), as_of)


@router.get("/{symbol}/chart")
async def get_chart(
    period: Period = DEFAULT_PERIOD,
    symbol: str = Depends(deps.resolve_symbol),
    state: AppState = Depends(deps.get_state),
) -> dict:
    """OHLCV + MA5/MA20 + 골든/데드 크로스 / OHLCV plus MA5/MA20 and golden/dead cross signals."""
    data, as_of = await cached_chart(state, symbol, period)
    return envelope(data, deps.market_open_now(), as_of)


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
    return envelope(data, deps.market_open_now(), as_of)


@router.get("/{symbol}/orderbook")
async def get_orderbook(
    symbol: str = Depends(deps.resolve_symbol),
    state: AppState = Depends(deps.get_state),
) -> dict:
    """
    현재가 기반 호가 시뮬레이션 (실제 호가 아님) / Order book simulated from the current price (not real depth).

    같은 현재가는 항상 같은 호가를 만든다 (시드 = 현재가 x 100).
    A given price always yields the same book (seed = price x 100).
    """
    detail, as_of = await cached_detail(state, symbol)
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
    return envelope(data, deps.market_open_now(), as_of)


@router.get("/{symbol}/investors")
async def get_investors(
    symbol: str = Depends(deps.resolve_symbol),
    state: AppState = Depends(deps.get_state),
) -> dict:
    """
    일봉 거래량·종가 방향에서 파생한 수급 시뮬레이션 10일 (실데이터 아님).
    Ten days of investor flows derived from daily volume and close direction (not real data).
    """
    chart, as_of = await cached_chart(state, symbol, INVESTOR_PERIOD)
    market = deps.market_of(symbol)
    history = [
        (candle["time"], candle["close"], candle["volume"])
        for candle in chart.get("candles", [])
    ][-INVESTOR_DAYS:]
    rows = simulation.build_investor_trends(history, market)
    data = {
        "symbol": symbol,
        "market": market,
        "rows": [row.model_dump(mode="json") for row in rows],
        "simulated": True,
    }
    return envelope(data, deps.market_open_now(), as_of)
