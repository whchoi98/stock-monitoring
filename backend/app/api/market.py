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
from typing import List, Literal, Optional, Tuple, Union

from fastapi import APIRouter, Depends

from app.api import deps
from app.core import config
from app.models import Quote, envelope
from app.services import market_data, news, summary
from app.state import AppState

router = APIRouter(prefix="/api/market", tags=["market"])

# 잘못된 값은 FastAPI가 422로 거절한다 / FastAPI rejects any other value with 422
Market = Literal["us", "kr"]

# 시세 커버리지 임계값 = 전량. 시세 행은 제품 그 자체이므로 한 행이 빠지면 사용자가 보려던 종목이
# 사라진다 (`fetch_quotes`는 60% 이상을 성공으로 반환하므로 호출부가 이 판정을 해야 한다).
# Quote coverage threshold = full. A quote row *is* the product: one missing row is a symbol the user
# wanted and cannot see (`fetch_quotes` returns anything above 60% as a success, so the caller must judge).
FULL_COVERAGE = 1.0

# 지수·지표 커버리지 하한. 시세와 달리 "한 행이라도 빠지면 degraded"를 쓰지 않는다: 지수·지표는
# 대시보드의 추가 행이고 한 심볼이 NaN/휴장으로 빠지는 일은 일상이라, 전량 기준을 쓰면 yahoo가
# 사실상 상시 degraded가 되어 신호의 뜻이 사라진다. 하한(시세와 같은 60%)은 데드라인이 여러 행을
# 한꺼번에 삼키는 모양(예: 5심볼 중 1행만 파싱)을 잡아내고 한두 행의 잡음은 흘려보낸다.
# Coverage floor for indices and indicators. Unlike quotes this is not "any missing row degrades": these
# are additive dashboard rows where a single NaN/holiday gap is routine, so a full-coverage rule would pin
# yahoo to degraded and drain the signal of meaning. The floor (the same 60% quotes use) catches the
# deadline shape - many rows lost at once, e.g. 1 of 5 indices parsed - and lets one- or two-row noise pass.
ADDITIVE_MIN_COVERAGE = market_data.QUOTE_MIN_COVERAGE


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


def quote_coverage(market: str, quotes: list) -> Tuple[int, int]:
    """
    커버리지 = (반환 행 수, 요청 심볼 수) / Coverage as (returned rows, requested symbols).

    `market_data.fetch_quotes`는 커버리지 60~99%를 성공으로 반환하므로(하한 미달만 예외),
    호출부가 이 비율을 직접 봐야 부분 성공이 `/api/health`에 드러난다. 라우트와 스케줄러가 같은
    판정을 쓰도록 여기 한 곳에 둔다.
    `fetch_quotes` returns 60-99% coverage as a success (only below the floor raises), so the caller has
    to look at the ratio for a partial to reach `/api/health`. Kept here so the route and the scheduler
    judge it identically.
    """
    return len(quotes), len(market_data.market_symbols(market))


def coverage_shortfall(kind: str, parsed: int, requested: int, minimum: float) -> Optional[dict]:
    """
    커버리지가 하한 미달이면 경고용 detail dict, 충분하면 None / Detail dict when coverage is short, else None.

    Args:
        kind: 로그에 남을 조각 이름 (예: "indices", "quotes:us") / Piece name for the log.
        parsed: 실제로 파싱된 행 수 / Rows actually parsed.
        requested: 요청한 심볼 수 / Symbols requested.
        minimum: 하한 비율 (`FULL_COVERAGE` 또는 `ADDITIVE_MIN_COVERAGE`) / Floor ratio.

    Returns:
        `{"kind", "parsed", "requested", "minimum"}` 또는 None / The detail dict, or None.
    """
    if requested <= 0 or parsed >= requested * minimum:
        # requested == 0은 판정할 것이 없다 (0으로 나누지 않는다) / nothing to judge, and never divide by zero
        return None
    return {"kind": kind, "parsed": parsed, "requested": requested, "minimum": minimum}


async def cached_quotes(state: AppState, market: str) -> Tuple[list, str]:
    """
    고정 키 `quotes:{market}`로 시세 조회 / Read quotes through the fixed key `quotes:{market}`.

    부분 성공은 `deps.Partial`로 감싸 전달한다: 행은 그대로 캐시·응답에 쓰이고 `sources.yahoo`만
    degraded가 된다 (빈 화면 대신 30/50행을 보여주되 그 사실을 숨기지 않는다).
    A partial is handed over wrapped in `deps.Partial`: the rows are cached and served as usual while
    `sources.yahoo` goes degraded — 30 of 50 rows beats a blank table, but it must not look healthy.
    """
    async def fetcher():
        payload = await quotes_payload(market)
        parsed, requested = quote_coverage(market, payload)
        if parsed < requested:
            return deps.Partial(payload, {"market": market, "parsed": parsed, "requested": requested})
        return payload

    return await deps.cached(
        state,
        deps.key_quotes(market),
        config.L2_TTL,
        fetcher,
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


def overview_shortfalls(indices: list, indicators: list, quotes: dict) -> List[dict]:
    """
    overview 네 조각의 커버리지 결손 목록 / Coverage shortfalls across the overview's four pieces.

    Args:
        indices: 파싱된 IndexQuote 리스트 / Parsed IndexQuote list.
        indicators: 파싱된 Indicator 리스트 / Parsed Indicator list.
        quotes: {시장: 시세 dict 리스트} / {market: quote dict list}.

    Returns:
        결손 detail dict 리스트 (없으면 빈 리스트) / A list of shortfall details, empty when complete.
    """
    found = [
        coverage_shortfall(
            "indices", len(indices), len(market_data.index_symbols()), ADDITIVE_MIN_COVERAGE
        ),
        coverage_shortfall(
            "indicators", len(indicators), len(market_data.indicator_symbols()), ADDITIVE_MIN_COVERAGE
        ),
    ]
    for market, rows in quotes.items():
        parsed, requested = quote_coverage(market, rows)
        found.append(coverage_shortfall(deps.key_quotes(market), parsed, requested, FULL_COVERAGE))
    return [shortfall for shortfall in found if shortfall is not None]


async def overview_payload(state: AppState) -> Union[dict, deps.Partial]:
    """
    지수·지표를 새로 조회하고 시세는 캐시에서 가져와 overview를 만든다.
    Fetch indices and indicators fresh, take quotes from the cache, and build the overview.

    불완전한 조각이 하나라도 있으면 `deps.Partial`로 감싸 반환한다. 안쪽 `cached_quotes`가 부분 시세를
    degraded로 마킹해도, 바깥쪽 `deps.cached(KEY_OVERVIEW, ...)`가 평범한 dict를 받으면 무조건 ok로
    다시 마킹해 그것을 지운다(last-writer-wins). 그래서 콜드 overview 한 번이 `yahoo: ok`와 짧은
    테이블을 동시에 내놓았다 — 감싸서 반환하면 바깥쪽도 degraded로 마킹한다. 지수·지표의 결손도 같은
    경로로 흘려보낸다 (데드라인이 남은 행을 삼켜도 헬스가 정상이라고 말하지 않게).
    Returns a `deps.Partial` when any piece is incomplete. The inner `cached_quotes` marks a partial
    degraded, but the outer `deps.cached(KEY_OVERVIEW, ...)` re-marks ok for any plain dict and erases it
    (last-writer-wins), which is how one cold overview reported `yahoo: ok` while serving a short table.
    Wrapping makes the outer call degrade too, and index/indicator shortfalls ride the same path so a
    deadline-truncated dashboard never looks healthy.

    Returns:
        overview dict, 또는 결손이 있으면 그 dict를 담은 `deps.Partial`.
        The overview dict, or a `deps.Partial` carrying it when a piece fell short.
    """
    indices = await asyncio.to_thread(market_data.fetch_indices)
    indicators = await asyncio.to_thread(market_data.fetch_indicators)
    us_quotes, _ = await cached_quotes(state, "us")
    kr_quotes, _ = await cached_quotes(state, "kr")

    payload = build_overview(indices, indicators, us_quotes, kr_quotes)
    shortfalls = overview_shortfalls(indices, indicators, {"us": us_quotes, "kr": kr_quotes})
    if shortfalls:
        return deps.Partial(payload, {"shortfall": shortfalls})
    return payload


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
