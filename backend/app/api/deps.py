"""
라우트 공용 의존성 - AppState 접근, 심볼 검증, 고정 캐시 키, 캐시 경유 조회 래퍼.
Shared route dependencies - AppState access, symbol validation, fixed cache keys, cached-fetch wrapper.

동기 서비스(yfinance)는 라우트에서 `asyncio.to_thread`로 감싸 호출한다 (이벤트 루프 블로킹 금지).
Synchronous services (yfinance) are called through `asyncio.to_thread` so the event loop never blocks.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Tuple

from fastapi import HTTPException, Request

from app.core import config
from app.core.market_hours import any_market_open, is_kr_market_open, is_us_market_open
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


# 부분 성공 로그 한 줄이 소유하는 필드 이름 / Field names owned by the partial-warning line itself
_RESERVED_LOG_FIELDS = ("event", "key", "source")


def partial_log_fields(key: str, source: str, detail: dict) -> dict:
    """
    `Partial.detail`을 경고 필드로 병합 (예약 이름 충돌 방어) / Merge `Partial.detail` into warning fields.

    `detail`은 fetcher가 만드는 임의의 dict다. 거기에 `key`/`source`/`event`가 들어오면
    `_warn(event, key=..., source=..., **detail)`이 "multiple values for argument" TypeError로 죽어
    부분 성공 경고 자체가 사라진다 — 조용한 실패를 막으려고 넣은 로그가 조용히 사라지는 셈이다.
    충돌한 값은 버리지 않고 `detail_*`로 옮겨 보존한다. 라우트(`cached`)와 스케줄러가 같은 병합
    규칙을 쓰도록 공개한다.
    `detail` is an arbitrary dict built by the fetcher. A `key`/`source`/`event` inside it would make
    `_warn(event, key=..., source=..., **detail)` die with a "multiple values for argument" TypeError,
    deleting the very warning that exists to prevent silent failure. Colliding entries are preserved
    under a `detail_` prefix rather than dropped. Public so the routes (`cached`) and the scheduler share
    one merge rule.
    """
    fields: dict = {"key": key, "source": source}
    for name, value in detail.items():
        fields[f"detail_{name}" if name in _RESERVED_LOG_FIELDS else name] = value
    return fields


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


def market_open_now(market: str | None = None) -> bool:
    """시장 범위의 장중 여부, 범위가 없으면 두 시장 OR / Scoped market hours; unscoped responses use either market."""
    now = datetime.now(timezone.utc)
    if market == "us":
        return is_us_market_open(now)
    if market == "kr":
        return is_kr_market_open(now)
    return any_market_open(now)


# ---------------------------------------------------------------------------
# 캐시 경유 조회 / Cached fetch
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Partial:
    """
    "성공했지만 불완전한" 페이로드 래퍼 / Wrapper for a payload that succeeded but is incomplete.

    fetcher가 이것을 반환하면 `cached`는 값을 그대로 캐시·응답에 쓰면서도 소스를 degraded로
    마킹한다. 예외를 던지는 것과 다르다: 부분 결과는 마지막 정상값보다 최신이므로 서빙·캐시할
    가치가 있지만, 조용히 ok로 넘기면 예를 들어 US 테이블이 50행 중 30행만 나오는 동안
    `/api/health`가 "완전 정상"이라고 보고한다 (2026-08-04 장애 리뷰 지적 사항).
    A fetcher returning this gets its value cached and served as usual, but the source is marked
    degraded. This is deliberately not an exception: a partial is newer than the last good value and
    worth serving, yet passing it silently as ok would let `/api/health` claim full health while, say,
    the US table shows 30 of 50 rows (raised by the 2026-08-04 incident review).

    Attributes:
        value: 캐시·응답에 쓰이는 실제 페이로드 / The real payload that gets cached and returned.
        detail: 경고 로그에 함께 담을 필드 (예: parsed/requested) / Extra fields for the warning log.
    """

    value: Any
    detail: dict = field(default_factory=dict)


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
        fetcher: 업스트림 조회 async 콜러블. `Partial`을 반환하면 값은 그대로 쓰고 소스만 degraded.
            Async callable that queries upstream; returning `Partial` keeps the value but degrades the source.
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
        if isinstance(value, Partial):
            # 부분 성공: 값은 캐시·응답에 쓰지만 헬스에서는 정상이 아니다 / cached and served, but not healthy
            state.mark_source(source, STATUS_DEGRADED)
            _warn("route_fetch_partial", **partial_log_fields(key, source, value.detail))
            return value.value
        state.mark_source(source, STATUS_OK)
        return value

    try:
        value, as_of, _origin = await state.cache.get_or_fetch(key, ttl, guarded)
    except Exception as exc:
        _warn("route_data_unavailable", key=key, source=source, error=str(exc))
        raise HTTPException(status_code=503, detail=f"data unavailable: {key}") from exc
    return value, as_of
