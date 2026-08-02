"""
라우트 공용 의존성 - AppState 접근, 심볼 검증, 고정 캐시 키, 캐시 경유 조회 래퍼.
Shared route dependencies - AppState access, symbol validation, fixed cache keys, cached-fetch wrapper.

동기 서비스(yfinance)는 라우트에서 `asyncio.to_thread`로 감싸 호출한다 (이벤트 루프 블로킹 금지).
Synchronous services (yfinance) are called through `asyncio.to_thread` so the event loop never blocks.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Tuple

from fastapi import HTTPException, Request

from app.core import config
from app.core.market_hours import any_market_open
from app.state import AppState, STATUS_DEGRADED, STATUS_OK

logger = logging.getLogger(__name__)

# 한국 종목 접미사 / Korean ticker suffixes
KR_SUFFIXES = (".KS", ".KQ")

# 라우트가 받아들이는 심볼 유니버스 (US 50 + KR 50).
# 캐시 키는 이 집합을 통과한 심볼로만 만들어지므로 계층 캐시의 키/락 맵도 함께 유한해진다.
# Symbol universe accepted by the routes (US 50 + KR 50). Cache keys are only ever built from
# symbols that pass this check, which is what keeps the tiered cache's key and lock maps finite.
SYMBOL_UNIVERSE = frozenset(config.US_STOCKS) | frozenset(config.KR_STOCKS)

# 소스 키 (헬스 응답과 동일한 이름) / Source keys (same names as in the health response)
SOURCE_YAHOO = "yahoo"
SOURCE_RSS = "rss"

# 고정 캐시 키 / Fixed cache keys
KEY_OVERVIEW = "overview"
KEY_NEWS_FEED = "news:feed"


def key_quotes(market: str) -> str:
    """시장별 시세 캐시 키 / Per-market quotes cache key."""
    return f"quotes:{market}"


def key_detail(symbol: str) -> str:
    """종목 상세 캐시 키 / Stock detail cache key."""
    return f"detail:{symbol}"


def key_chart(symbol: str, period: str) -> str:
    """종목 차트 캐시 키 / Stock chart cache key."""
    return f"chart:{symbol}:{period}"


def key_news(symbol: str) -> str:
    """종목 뉴스 캐시 키 / Per-symbol news cache key."""
    return f"news:{symbol}"


# 스케줄러가 선제 갱신하는 키 - /api/health가 age를 보고하는 대상
# Keys the scheduler pre-warms; /api/health reports their age
PREWARMED_KEYS = (KEY_OVERVIEW, key_quotes("us"), key_quotes("kr"), KEY_NEWS_FEED)


def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


# ---------------------------------------------------------------------------
# 의존성 / Dependencies
# ---------------------------------------------------------------------------

def get_state(request: Request) -> AppState:
    """
    `app.state.ctx`에 저장된 AppState 반환 / Return the AppState stored on `app.state.ctx`.

    Raises:
        HTTPException: 컨텍스트가 준비되지 않았을 때 503 (헬스체크는 별도로 200을 유지한다).
        HTTPException: 503 when the context is missing (the health route still answers 200).
    """
    state = getattr(request.app.state, "ctx", None)
    if state is None:
        _warn("app_state_missing", path=request.url.path)
        raise HTTPException(status_code=503, detail="app_not_ready")
    return state


def resolve_symbol(symbol: str) -> str:
    """
    경로의 심볼을 유니버스 형식으로 정규화 / Normalize a path symbol into its universe form.

    캐시 키를 만들기 **전에** 호출되어야 한다 (유니버스 밖 심볼로 키·락이 생기지 않게 한다).
    Must run *before* any cache key is built, so off-universe symbols never create keys or locks.

    Args:
        symbol: 경로 파라미터 심볼 (대소문자 무관) / Path parameter symbol (case-insensitive).

    Returns:
        정규화된 심볼 (예: `aapl` -> `AAPL`) / The normalized symbol (e.g. `aapl` -> `AAPL`).

    Raises:
        HTTPException: 유니버스 밖 심볼은 404 / 404 for a symbol outside the universe.
    """
    normalized = symbol.strip().upper()
    if normalized not in SYMBOL_UNIVERSE:
        raise HTTPException(status_code=404, detail=f"unknown symbol: {symbol}")
    return normalized


def market_of(symbol: str) -> str:
    """심볼 접미사로 시장 판별 / Derive the market from the ticker suffix."""
    return "kr" if symbol.upper().endswith(KR_SUFFIXES) else "us"


def market_open_now() -> bool:
    """모든 응답 envelope에 들어가는 장중 여부 / The market-open flag every response envelope carries."""
    return any_market_open(datetime.now(timezone.utc))


# ---------------------------------------------------------------------------
# 캐시 경유 조회 / Cached fetch
# ---------------------------------------------------------------------------

async def cached(
    state: AppState,
    key: str,
    ttl: int,
    fetcher: Callable[[], Awaitable[Any]],
    source: str,
) -> Tuple[Any, str]:
    """
    계층 캐시로 값을 조회하고 소스 상태를 갱신 / Read a value through the tiered cache and update source status.

    fetcher는 JSON 직렬화 가능한 값을 반환해야 한다 (L2가 JSON 문자열로 저장한다).
    The fetcher must return a JSON-serializable value because L2 stores it as a JSON string.

    Args:
        state: 앱 컨텍스트 / App context.
        key: 고정 캐시 키 / Fixed cache key.
        ttl: 캐시 TTL(초) / Cache TTL in seconds.
        fetcher: 업스트림 조회 async 콜러블 / Async callable that queries upstream.
        source: 소스 키 (예: "yahoo") / Source key (e.g. "yahoo").

    Returns:
        (값, asOf ISO8601) / (value, asOf ISO8601).

    Raises:
        HTTPException: 캐시(stale 포함)와 업스트림이 모두 실패하면 503 - 빈 응답으로 위장하지 않는다.
        HTTPException: 503 when both the cache (stale included) and upstream fail; never a fake empty body.
    """
    async def guarded() -> Any:
        try:
            value = await fetcher()
        except Exception as exc:
            # 조용한 실패 금지: 로그 + 헬스의 소스 상태에 반영 / No silent failure: log it and mark the source
            state.mark_source(source, STATUS_DEGRADED)
            _warn("route_fetch_failed", key=key, source=source, error=str(exc))
            raise
        state.mark_source(source, STATUS_OK)
        return value

    try:
        value, as_of, _origin = await state.cache.get_or_fetch(key, ttl, guarded)
    except Exception as exc:
        _warn("route_data_unavailable", key=key, source=source, error=str(exc))
        raise HTTPException(status_code=503, detail=f"data unavailable: {key}") from exc
    return value, as_of
