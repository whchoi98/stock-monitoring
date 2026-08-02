"""
시장 라우트 - 지수/경제지표/시장요약/섹터, 시장별 시세 테이블, 뉴스 피드.
Market routes - indices, economic indicators, market summary and sectors, per-market quote tables, news feed.

동기 서비스(yfinance)는 전부 `asyncio.to_thread`로 감싸 이벤트 루프를 막지 않는다.
Every synchronous service (yfinance) is wrapped in `asyncio.to_thread` so the event loop never blocks.

캐시에는 pydantic 모델이 아니라 JSON 직렬화된 dict를 담는다 (L2가 JSON 문자열로 저장한다).
The cache holds JSON-serialized dicts rather than pydantic models, because L2 stores a JSON string.
"""
from __future__ import annotations

import asyncio
from typing import Literal, Tuple

from fastapi import APIRouter, Depends

from app.api import deps
from app.core import config
from app.models import Quote, envelope
from app.services import market_data, news, summary
from app.state import AppState

router = APIRouter(prefix="/api/market", tags=["market"])

# 잘못된 값은 FastAPI가 422로 거절한다 / FastAPI rejects any other value with 422
Market = Literal["us", "kr"]


# ---------------------------------------------------------------------------
# 페이로드 빌더 (스케줄러 B12도 재사용) / Payload builders (also reused by the B12 scheduler)
# ---------------------------------------------------------------------------

async def quotes_payload(market: str) -> list:
    """
    시장 전체 시세를 조회해 dict 리스트로 / Fetch a market's quotes as a list of dicts.

    `market_cap`은 여기서 채우지 않는다 (B12 스케줄러가 `fetch_market_caps`로 별도 주기 갱신).
    `market_cap` is not filled here; the B12 scheduler refreshes it via `fetch_market_caps`.
    """
    quotes = await asyncio.to_thread(market_data.fetch_quotes, market)
    return [quote.model_dump(mode="json") for quote in quotes]


async def cached_quotes(state: AppState, market: str) -> Tuple[list, str]:
    """고정 키 `quotes:{market}`로 시세 조회 / Read quotes through the fixed key `quotes:{market}`."""
    return await deps.cached(
        state,
        deps.key_quotes(market),
        config.L2_TTL,
        lambda: quotes_payload(market),
        deps.SOURCE_YAHOO,
    )


def build_overview(indices: list, indicators: list, us_quotes: list, kr_quotes: list) -> dict:
    """
    overview 응답 데이터 조립 (순수 함수) / Assemble the overview response data (pure function).

    Args:
        indices: IndexQuote 리스트 / IndexQuote list.
        indicators: Indicator 리스트 / Indicator list.
        us_quotes: 미국 시세 dict 리스트 / US quote dicts.
        kr_quotes: 한국 시세 dict 리스트 / KR quote dicts.

    Returns:
        `{"indices", "indicators", "summary", "sectors": {"us", "kr"}}`.
    """
    # 요약/섹터 집계는 Quote 객체를 받으므로 캐시된 dict를 되돌린다
    # The summary and sector aggregations take Quote objects, so cached dicts are re-validated
    us = [Quote.model_validate(quote) for quote in us_quotes]
    kr = [Quote.model_validate(quote) for quote in kr_quotes]
    return {
        "indices": [index.model_dump(mode="json") for index in indices],
        "indicators": [indicator.model_dump(mode="json") for indicator in indicators],
        "summary": summary.build_summary(us, kr),
        "sectors": {"us": summary.build_sectors(us), "kr": summary.build_sectors(kr)},
    }


async def overview_payload(state: AppState) -> dict:
    """
    지수·지표를 새로 조회하고 시세는 캐시에서 가져와 overview를 만든다.
    Fetch indices and indicators fresh, take quotes from the cache, and build the overview.
    """
    indices = await asyncio.to_thread(market_data.fetch_indices)
    indicators = await asyncio.to_thread(market_data.fetch_indicators)
    us_quotes, _ = await cached_quotes(state, "us")
    kr_quotes, _ = await cached_quotes(state, "kr")
    return build_overview(indices, indicators, us_quotes, kr_quotes)


async def news_payload() -> list:
    """RSS 뉴스 피드를 dict 리스트로 (서비스가 이미 async) / The RSS news feed as dicts (the service is already async)."""
    items = await news.fetch_news()
    return [item.model_dump(mode="json") for item in items]


# ---------------------------------------------------------------------------
# 라우트 / Routes
# ---------------------------------------------------------------------------

@router.get("/overview")
async def get_overview(state: AppState = Depends(deps.get_state)) -> dict:
    """지수 + 경제지표 + 시장요약 + 섹터 등락 / Indices, indicators, market summary and sector moves."""
    data, as_of = await deps.cached(
        state,
        deps.KEY_OVERVIEW,
        config.L2_TTL,
        lambda: overview_payload(state),
        deps.SOURCE_YAHOO,
    )
    return envelope(data, deps.market_open_now(), as_of)


@router.get("/quotes")
async def get_quotes(market: Market, state: AppState = Depends(deps.get_state)) -> dict:
    """한 시장의 50종목 시세 테이블 / One market's 50-symbol quote table."""
    data, as_of = await cached_quotes(state, market)
    return envelope(data, deps.market_open_now(), as_of)


@router.get("/news")
async def get_news(state: AppState = Depends(deps.get_state)) -> dict:
    """RSS 뉴스 피드 / The RSS news feed."""
    data, as_of = await deps.cached(
        state,
        deps.KEY_NEWS_FEED,
        config.L2_TTL,
        news_payload,
        deps.SOURCE_RSS,
    )
    return envelope(data, deps.market_open_now(), as_of)
