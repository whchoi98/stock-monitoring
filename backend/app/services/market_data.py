"""
시장 데이터 서비스 - yfinance만 사용해 지수/경제지표/시세를 조회 (pykrx·스크래핑 미사용)
Market data service - indices, economic indicators and quotes via yfinance only (no pykrx/scraping).

TUI 프로젝트(`stock-on-tui/services/us_stocks.py`, `indicators.py`)의 파싱 로직을 포팅했다.
Ported from the TUI project's `us_stocks.py` / `indicators.py` parsing logic.

KR 종목도 US와 완전히 동일한 경로를 쓴다 (config 심볼이 이미 `.KS`/`.KQ` 접미사를 갖는다).
KR symbols go through the exact same yfinance path as US (config symbols already carry .KS/.KQ).

모든 함수는 동기다 (yfinance가 동기) — 호출부에서 `asyncio.to_thread`로 감쌀 것.
All functions are synchronous (yfinance is): wrap them in `asyncio.to_thread` at the call site.
"""
from __future__ import annotations

import json
import logging
import math
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, Iterable, Iterator, List, Literal, Optional, Sequence, Sized, Tuple

import yfinance as yf

from app.core import config
from app.models import Indicator, IndexQuote, Quote

logger = logging.getLogger(__name__)


class QuotesUnavailableError(RuntimeError):
    """
    시장 시세 조회가 쓸 수 없는 수준이다 (전체 공백 또는 커버리지 하한 미달).
    A market's quote fetch is unusable: all-empty, or below the coverage floor.

    빈/심하게 부족한 결과를 반환(=성공)하는 대신 이 예외를 던져야 `deps.cached`의
    stale-while-error 폴백이 마지막 정상 데이터를 계속 서빙한다 (2026-08-04 라이브 장애 교훈).
    Raised instead of returning an empty or severely partial list so `deps.cached`'s
    stale-while-error fallback keeps serving the last good data (lesson from the 2026-08-04 incident).
    """

# 지수/지표 조회 기간 - 휴장일 NaN 행을 흡수할 만큼 넉넉히 / Period for indices & indicators (absorbs holiday NaN rows)
INDEX_PERIOD = "5d"
INDICATOR_PERIOD = "5d"
# 시세 조회 기간 / Period for quotes
QUOTE_PERIOD = "7d"

# yfinance HTTP 요청 1건의 타임아웃(초). `threads=False`인 `yf.download`는 배치를 받아도 심볼당
# 순차 HTTP 요청을 보내므로(yfinance/multi.py의 `_download_one` 루프) 이 값은 "배치 전체"가 아니라
# "요청 1건"의 상한이다. yfinance 기본값(10s)에 기대지 않고 명시한다.
# Timeout for one yfinance HTTP request. With `threads=False`, `yf.download` issues one sequential
# request per symbol even for a batch (the `_download_one` loop in yfinance/multi.py), so this bounds
# a single request, not a whole batch. Explicit rather than relying on yfinance's 10s default.
DOWNLOAD_TIMEOUT = 8

# 주의 — 이 8초는 crumb(쿠키/CSRF 토큰)이 이미 따뜻할 때의 상한이다. yfinance는 매 요청 앞에서
# `_get_cookie_and_crumb()`를 **우리 timeout 없이** 호출하므로(yfinance 1.5.2 `data.py:429` →
# `data.py:371`) 그 구간은 자체 기본값 30s를 쓴다. 즉 crumb이 없거나 갱신 중이면 요청 1건의 실제
# 상한은 8s가 아니라 ~38s다. 아래 데드라인들은 "언제 새 요청을 그만 낼지"만 정하므로, 실제 벽시계
# 상한은 항상 "데드라인 + 진행 중인 요청 1건(crumb 갱신 포함 가능)"으로 읽어야 한다.
# Caveat: 8s bounds one request only while the crumb (cookie/CSRF token) is warm. yfinance calls
# `_get_cookie_and_crumb()` **without** our timeout before every request (yfinance 1.5.2 `data.py:429`
# -> `data.py:371`), so that leg falls back to its own 30s default: with a cold or refreshing crumb a
# single request's true ceiling is ~38s, not 8s. Every deadline below only decides when to stop
# issuing new requests, so the real wall-clock bound is always "deadline + one in-flight request
# (possibly including a crumb refresh)".

# ---------------------------------------------------------------------------
# 예산 / Budgets
# ---------------------------------------------------------------------------
# 실측 기준: 이 호스트에서 정상 상태의 yfinance 요청 1건 ≈ 0.3s/심볼 (2026-08-04 측정). 아래 예산은
# 모두 이 값의 배수(= 허용 열화 배수)로 읽는다 — 마법의 상수가 아니다.
# Measured baseline: one healthy yfinance request from this host is ≈ 0.3s/symbol (2026-08-04). Every
# budget below is expressed as a multiple of it (= the latency degradation it tolerates), not a magic
# number.
#
# 60초 천장 배분 / Splitting the 60s ceiling:
#   콜드 `/api/market/overview` 한 요청은 네 조각을 **순차로** 조회한다 — 지수 → 지표 → quotes:us →
#   quotes:kr. 요청 1건의 벽시계 천장은 CloudFront 오리진 read timeout(`CLOUDFRONT_ORIGIN_READ_TIMEOUT`
#   = 60s)이므로 "새 요청을 그만 내는" 시점의 합을 그 아래로 눌러 둔다:
#     INDEX_FETCH_DEADLINE(3s) + INDICATOR_FETCH_DEADLINE(5s)       =  8s
#     quotes 두 조각 = 2 × QUOTE_FETCH_DEADLINE_MAX(20s)             = 40s
#     합계                                                            = 48s (천장까지 12s 여유)
#   남은 12s는 pydantic 재검증·JSON 직렬화·ALB 홉·L2(DynamoDB) 왕복의 몫이다. 조립(summary/sectors)
#   자체는 ~100행 순수 CPU로 무시할 만하지만, 여유를 0으로 둘 이유는 없다 — 예전 배분(4+6+25+25)은
#   정확히 60s여서 이 여유가 존재하지 않았다.
#   그리고 각 단계는 진행 중인 요청 1건만큼 예산을 넘길 수 있다 — 단계가 4개이므로 최대 4건이고,
#   warm crumb에서 1건 ≈ 8s, cold crumb이면 ≈ 38s다(위 주의사항). 즉 48s는 상한이 아니라 "그만 내는"
#   합이며, 초과 시 손실은 그 overview 요청 1건의 504뿐이다 (캐시·스케줄러 경로는 무관하고 다음
#   요청은 캐시된 값을 받는다). 4단계가 동시에 늦어지는 최악은 어떤 배분으로도 막을 수 없다 —
#   그것을 흡수하는 것은 예산이 아니라 stale-while-error와 스케줄러의 선제 갱신이다.
#   스케줄러(REFRESH_INTERVAL 45s)는 대기를 갱신 *뒤*에 하므로 사이클이 밀릴 뿐 겹치지 않는다.
#   A cold `/api/market/overview` fetches four pieces *serially* - indices, indicators, quotes:us,
#   quotes:kr - and CloudFront's 60s origin read timeout (`CLOUDFRONT_ORIGIN_READ_TIMEOUT`) caps that
#   one request, so the "stop issuing new requests" sum is held under it: 3s + 5s of
#   indices/indicators plus 2 × 20s of quotes = 48s, leaving 12s of the ceiling for pydantic
#   re-validation, JSON serialization, the ALB hop and L2 (DynamoDB) round-trips. The previous split
#   (4+6+25+25) was exactly 60s, i.e. zero margin. Each stage can additionally overrun by one
#   in-flight request - four stages, so up to four, ≈ 8s each with a warm crumb and ≈ 38s with a cold
#   one (see the caveat above). 48s is therefore a "stop issuing" sum, not a bound; exceeding it costs
#   a 504 on that single overview request (cache and scheduler paths untouched, the next request is
#   served from cache). No split can prevent all four stages being slow at once - what absorbs that is
#   stale-while-error plus the scheduler's pre-warming, not the budget. The scheduler waits *after*
#   each refresh, so a long cycle slips rather than overlaps.
#
# 명시적으로 기각한 대안 — 네 조각을 `asyncio.gather`로 동시에 / Explicitly rejected alternative:
#   `asyncio.gather` over the four pieces.
#   합계가 max(3, 5, 20, 20) = 20s로 줄어 천장 여유가 커지지만, Yahoo를 향한 **동시성**이 정확히
#   2026-08-04 장애의 방아쇠였다 (10심볼 × 5워커 병렬 버스트 → 전 심볼 빈 프레임 → 빈 리스트가
#   "성공"으로 캐시되어 마지막 정상 시세를 밀어냄). 순차 실행은 게으름이 아니라 그 장애의 대응이고,
#   지연은 예산 + 캐시 + 스케줄러로 흡수한다.
#   It would cut the sum to max(3, 5, 20, 20) = 20s, but concurrency toward Yahoo is exactly what
#   triggered the 2026-08-04 incident (a 10-symbols × 5-workers parallel burst answered with all-empty
#   frames, whose empty list was cached as "success" and evicted the last good quotes). Serial is a
#   deliberate consequence of that incident, not an oversight; latency is absorbed by the budgets, the
#   cache and the scheduler instead.

# CloudFront 오리진 read timeout(초) — 요청 1건의 벽시계 천장 (infra/stacks에 설정된 값).
# 코드에 상수로 두어 위 배분 산술을 테스트가 검증할 수 있게 한다 (주석만으로는 드리프트한다).
# CloudFront's origin read timeout in seconds - the wall-clock ceiling for one request, as configured in
# infra/stacks. Kept as a constant so a test can assert the arithmetic above; a comment alone drifts.
CLOUDFRONT_ORIGIN_READ_TIMEOUT = 60

# 지수 5심볼(US 3 + KR 2)의 전체 예산(초) / Total budget for the 5 index symbols (US 3 + KR 2).
# 3s / 5심볼 = 0.6s/심볼 = 실측의 2배. 만료 시 남은 심볼을 포기하고 파싱된 행만 반환한다 —
# 지수는 시장 테이블이 아니라 대시보드의 추가 행이므로 예외를 던지지 않는다.
# 주의: 이 예산은 요청 1건 상한(`DOWNLOAD_TIMEOUT` = 8s)보다 **작다**. 느린 요청 1건이 타임아웃까지
# 가면 예산이 그 자리에서 소진되어 남은 지수 행 전부를 잃는다. 그 대가로 천장 여유(위 12s)를 사는
# 의도된 트레이드오프이고, 손실은 조용하지 않다 — 잘린 결과는 라우트의 커버리지 판정을 통해
# `/api/health`의 yahoo를 degraded로 만든다 (`app/api/market.py`의 `ADDITIVE_MIN_COVERAGE`).
# 3s over 5 symbols = 0.6s each = 2× the measured latency. On expiry the rest are dropped and the
# parsed rows are returned: indices are additive dashboard rows, not the market table, so nothing raises.
# Note the budget is *below* the per-request cap (`DOWNLOAD_TIMEOUT` = 8s): one request that runs to its
# timeout spends the whole budget and loses every remaining index row. That buys the ceiling margin
# above (12s) and is deliberate - and the loss is not silent, because a truncated result degrades
# `/api/health`'s yahoo through the route's coverage gate (`ADDITIVE_MIN_COVERAGE` in `app/api/market.py`).
INDEX_FETCH_DEADLINE = 3

# 경제지표 11심볼의 전체 예산(초) / Total budget for the 11 indicator symbols.
# 5s / 11심볼 = 0.45s/심볼 = 실측의 1.5배. 지수와 동일한 부분 결과 규약이며, 요청 1건 상한(8s)보다
# 작다는 주의사항도 동일하게 적용된다.
# 5s over 11 symbols = 0.45s each = 1.5× the measured latency; same partial-result contract as indices,
# and the same "below the 8s per-request cap" caveat applies.
INDICATOR_FETCH_DEADLINE = 5

# `fetch_quotes` 한 호출의 전체 벽시계 예산 = 심볼 수 × QUOTE_BUDGET_PER_SYMBOL (상한 클램프).
# Total wall-clock budget for one `fetch_quotes` call = symbol count × QUOTE_BUDGET_PER_SYMBOL, clamped.
#
# 왜 심볼당인가 / Why per-symbol:
#   - 요청 1건 상한 = DOWNLOAD_TIMEOUT(8s). 심볼 50개면 1차 패스만으로 50×8 = 400s가 가능하고
#     재시도까지 더하면 두 배다. `fetch_quotes`는 `asyncio.to_thread`(공용 기본 executor)에서 돌기
#     때문에 총 예산이 없으면 워커가 분 단위로 묶인다.
#   - 고정 상수는 심볼 수가 바뀌면 뜻이 바뀐다: 50심볼에 25s는 0.5s/심볼이고 실측 0.3s의 1.7배뿐
#     이다. 심볼당으로 쓰면 유니버스가 커질 때 예산이 함께 자라고, 작은 시장은 더 빨리 포기하며,
#     상한에 걸리는 지점이 코드에 드러난다.
#   - Per-request cap is 8s: a 50-symbol primary pass alone could reach 400s (doubled with the retry)
#     and it runs on the shared default executor, so the total budget is what frees the worker. A flat
#     constant also changes meaning with the symbol count, whereas a per-symbol budget grows with the
#     universe, gives up sooner on a small market, and makes the clamp point explicit.
#
# 현재 유니버스(50심볼)에서는 0.9 × 50 = 45s > 20s이므로 클램프가 유효하다. 즉 실효 헤드룸은
# 20/50 = 0.4s/심볼 = 실측의 1.33배이며, 그것은 예산 선택이 아니라 위 60s(overview 4단계 순차) /
# 45s(스케줄러 주기) 천장이 정한 한계다. 3배 열화의 완충은 예산이 아니라 커버리지 게이트 +
# stale-while-error가 맡는다 — 부분 결과를 캐시에 밀어넣는 대신 마지막 정상 시세를 계속 서빙한다.
# At the current 50-symbol universe 0.9 × 50 = 45s > 20s, so the clamp binds and the effective headroom
# is 20/50 = 0.4s per symbol = 1.33× the measured latency. That is a limit set by the ceilings above (60s
# across the overview's four serial stages, 45s per scheduler cycle), not by this constant; what absorbs a
# 3× degradation is the coverage gate plus stale-while-error, which keeps serving the last good quotes
# instead of pushing a thin partial into the cache.
QUOTE_BUDGET_PER_SYMBOL = 0.9  # 실측 0.3s/심볼 × 3배 열화 허용 / measured 0.3s × 3× degradation
QUOTE_FETCH_DEADLINE_MAX = 20

# 부분 성공 허용 하한 = 파싱 성공 심볼 / 요청 심볼. 이 값 이상이면 부분 결과를 반환하고(경고),
# 미달이면 예외를 던져 캐시의 마지막 정상 시세를 지킨다.
# Partial-success floor (parsed/requested): at or above it the partial result is returned with a
# warning, below it we raise so the cache's last good quotes survive.
QUOTE_MIN_COVERAGE = 0.6

# 재시도 패스 앞의 지터 백오프 범위(초). 고정 지연은 요청 간격을 예측 가능한 열차로 만들어
# 빈도 기반 스로틀에 그대로 걸린다.
# Jittered backoff range before the retry pass; a fixed delay makes the request spacing a predictable
# train that a frequency-based throttle can lock onto.
QUOTE_RETRY_BACKOFF = (0.4, 1.2)

# 시가총액 병렬 조회 / Market cap parallel fetch
MARKET_CAP_WORKERS = 10
MARKET_CAP_TIMEOUT = 20  # seconds

# market 인자 -> (심볼 목록 속성, 이름 매핑 속성, 섹터 매핑 속성, 통화)
# market argument -> (symbol list attr, name map attr, sector map attr, currency)
_MARKETS = {
    "us": ("US_STOCKS", "US_STOCK_NAMES", "US_STOCK_SECTORS", "USD"),
    "kr": ("KR_STOCKS", "KR_STOCK_NAMES", "KR_STOCK_SECTORS", "KRW"),
}


# ---------------------------------------------------------------------------
# 유틸리티 / Utilities
# ---------------------------------------------------------------------------

def _isnan(v: Any) -> bool:
    """값이 NaN인지 안전하게 확인 / Safely check whether a value is NaN."""
    try:
        return math.isnan(v)
    except (TypeError, ValueError):
        return False


def _safe_float(v: Any, default: float = 0.0) -> float:
    """안전하게 float 변환 (NaN/변환 실패 시 기본값) / Safely convert to float (default on NaN/failure)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(f) else f


def _safe_int(v: Any, default: int = 0) -> int:
    """안전하게 int 변환 (NaN/변환 실패 시 기본값) / Safely convert to int (default on NaN/failure)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return default if math.isnan(f) else int(f)


def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


def _now() -> float:
    """
    데드라인 계산용 단조 시계 / Monotonic clock used for deadlines.

    함수로 감싼 이유는 테스트가 가짜 시계를 주입할 수 있게 하기 위해서다.
    Wrapped in a function so tests can inject a fake clock.
    """
    return time.monotonic()


def _download(symbols: Sequence[str], period: str):
    """
    yfinance 다운로드 (모든 호출 경로가 동일한 인자를 쓰도록 단일화) / Single yfinance download entry point.

    `threads=False`는 동시성을 없앤다 — 여러 심볼을 넘겨도 yfinance가 심볼당 순차 HTTP 요청을 보낸다.
    `threads=False` removes concurrency: yfinance sends one sequential HTTP request per symbol even
    when several are passed. `timeout` therefore bounds a single request.
    """
    return yf.download(
        list(symbols),
        period=period,
        group_by="ticker",
        threads=False,
        progress=False,
        timeout=DOWNLOAD_TIMEOUT,
    )


def _serial_frames(
    symbols: Sequence[str],
    period: str,
    deadline: float,
    *,
    deadline_event: str,
    failure_event: str,
    parsed_so_far: Optional[Sized] = None,
    **fields: Any,
) -> Iterator[Tuple[str, Any]]:
    """
    심볼당 요청 1건을 순차로 내고 (심볼, 프레임)을 yield / Issue one request per symbol serially, yielding (symbol, frame).

    `yf.download(..., threads=False)`은 배치를 받아도 심볼당 순차 HTTP 요청을 보내므로
    (yfinance/multi.py의 `_download_one` 루프) 직접 심볼별로 부르면 업스트림이 보는 트래픽은 같고,
    그 대신 **요청 사이에서 데드라인을 확인**할 수 있다 — 배치 호출 하나는 중간에 끊을 방법이 없다.
    `yf.download(..., threads=False)` issues one sequential HTTP request per symbol even for a batch
    (the `_download_one` loop in yfinance/multi.py), so issuing them ourselves shows upstream the same
    traffic while letting the deadline be checked *between* requests; a single batch call cannot be
    interrupted mid-flight.

    데드라인 만료와 개별 요청 실패는 모두 경고만 남기고 계속/중단한다 (조용한 실패 금지).
    Both an expired deadline and a single failed request only warn (never silently); nothing raises.

    Args:
        symbols: 요청할 심볼 / Symbols to request.
        period: yfinance 조회 기간 / yfinance period.
        deadline: `_now()` 기준 종료 시각 — 지나면 새 요청을 내지 않는다 / `_now()`-based cutoff.
        deadline_event: 예산 소진 로그 이벤트 이름 / Log event name for budget exhaustion.
        failure_event: 요청 1건 실패 로그 이벤트 이름 / Log event name for one failed request.
        parsed_so_far: 호출부가 지금까지 파싱한 결과 (있으면 예산 소진 로그에 개수를 담는다).
            The caller's parsed-so-far collection; its length is added to the deadline log line.
        **fields: 두 로그에 함께 담을 문맥 / Extra context for both log lines.
    """
    for issued, symbol in enumerate(symbols):
        if _now() >= deadline:
            # 예산 소진: 남은 심볼은 포기하고 가진 것으로 판정한다 (워커를 붙잡아두지 않는다)
            # Budget spent: give up the rest and evaluate what we have (never hold the worker)
            spent = {} if parsed_so_far is None else {"parsed": len(parsed_so_far)}
            _warn(deadline_event, requested=len(symbols), issued=issued, **spent, **fields)
            return
        try:
            frame = _download([symbol], period)
        except Exception as exc:
            # 한 심볼의 실패가 남은 심볼을 죽이지 않는다 / One symbol's failure must not kill the pass
            _warn(failure_event, symbol=symbol, error=str(exc), **fields)
            continue
        yield symbol, frame


def _sub_frame(df, symbol: str, requested: int):
    """
    다운로드 프레임에서 심볼별 서브 프레임 추출 / Extract the per-symbol sub-frame from a download result.

    yfinance는 멀티 티커일 때 (ticker, field) 2단 MultiIndex 컬럼을, 단일 티커일 때는
    버전에 따라 MultiIndex 또는 평면 컬럼(Close/Volume)을 준다. 두 형태를 모두 처리한다.
    yfinance returns a 2-level (ticker, field) MultiIndex for multi-ticker downloads and either a
    MultiIndex or a flat Close/Volume frame for a single ticker; both shapes are handled here.

    Returns:
        서브 프레임 또는 None(데이터 없음/형태 불명) / The sub-frame, or None when absent/ambiguous.
    """
    if df is None or getattr(df, "empty", True):
        return None

    columns = df.columns
    if getattr(columns, "nlevels", 1) > 1:
        tickers = set(columns.get_level_values(0))
        if symbol in tickers:
            sub = df[symbol]
        elif len(tickers) == 1 and requested == 1:
            # 단일 티커 요청인데 레벨 라벨이 다른 경우 / Single-ticker request whose level label differs
            sub = df[next(iter(tickers))]
        else:
            return None
    elif requested == 1:
        sub = df  # 평면 단일 티커 프레임 / flat single-ticker frame
    else:
        # 여러 심볼을 요청했는데 평면 프레임이면 어느 심볼인지 알 수 없다 / Flat frame for a multi-symbol request is ambiguous
        return None

    return None if sub.empty else sub


def _valid_closes(sub):
    """NaN을 제거한 종가 시리즈 / Close series with NaN rows dropped."""
    return sub["Close"].dropna()


def _change(value: float, prev: float) -> tuple:
    """등락금액/등락률 계산 / Compute absolute and percentage change."""
    change = value - prev
    pct = (change / prev * 100) if prev else 0.0
    return change, pct


# ---------------------------------------------------------------------------
# 지수 / Indices
# ---------------------------------------------------------------------------

def index_symbols() -> list[str]:
    """
    지수 조회가 요청하는 심볼 유니버스 (US + KR) / The index symbol universe one fetch requests.

    `market_symbols`와 같은 이음새다: 호출부가 "반환 행 / 요청 심볼"로 커버리지를 계산해 데드라인에
    잘린 결과를 `/api/health`에 드러낼 수 있게 공개한다. 서비스는 AppState를 모르는 상태로 남는다.
    The same seam as `market_symbols`: public so callers can compute coverage (rows returned over
    symbols requested) and surface a deadline-truncated result in `/api/health`, while the service
    itself stays unaware of AppState.
    """
    return [*config.US_INDICES, *config.KR_INDICES]


def fetch_indices() -> list[IndexQuote]:
    """
    US + KR 주요 지수를 한 번의 일괄 다운로드로 조회 / Fetch US + KR major indices in one batch download.

    KR 지수도 yfinance 심볼(`^KS11`/`^KQ11`)을 사용한다 (pykrx 미사용).
    KR indices also use yfinance symbols (`^KS11`/`^KQ11`); pykrx is not used.

    `INDEX_FETCH_DEADLINE` 안에서 심볼당 요청 1건을 순차로 낸다. 예산이 만료되면 남은 심볼을 포기하고
    파싱된 행만 반환한다 (예외 없음) — 지수는 시장 테이블이 아니라 대시보드의 추가 행이다.
    One serial request per symbol inside `INDEX_FETCH_DEADLINE`; on expiry the remaining symbols are
    dropped and the parsed rows returned (nothing raises), because indices are additive dashboard rows
    rather than the market table.

    Returns:
        IndexQuote 리스트 (실패·예산 초과 심볼은 제외) / List of IndexQuote (failed and unbudgeted symbols omitted).
    """
    names = {**config.US_INDICES, **config.KR_INDICES}
    symbols = index_symbols()  # 커버리지 판정과 같은 목록 / the very list the coverage gate counts
    results: list[IndexQuote] = []

    frames = _serial_frames(
        symbols, INDEX_PERIOD, _now() + INDEX_FETCH_DEADLINE,
        deadline_event="indices_deadline_reached",
        failure_event="index_download_failed",
        parsed_so_far=results,
    )
    for symbol, frame in frames:
        try:
            sub = _sub_frame(frame, symbol, 1)
            if sub is None:
                _warn("index_data_missing", symbol=symbol)
                continue

            closes = _valid_closes(sub)
            if closes.empty:
                _warn("index_data_missing", symbol=symbol)
                continue

            # 마지막 2개 유효 종가로 등락 계산 / Change from the last two valid closes
            value = _safe_float(closes.iloc[-1])
            if value == 0:
                _warn("index_price_unavailable", symbol=symbol)
                continue
            prev = _safe_float(closes.iloc[-2], value) if len(closes) > 1 else value
            change, pct = _change(value, prev)

            results.append(
                IndexQuote(
                    symbol=symbol,
                    name=names[symbol],
                    value=value,
                    change=change,
                    change_pct=pct,
                )
            )
        except Exception as exc:
            _warn("index_parse_failed", symbol=symbol, error=str(exc))

    return results


# ---------------------------------------------------------------------------
# 경제지표 / Economic indicators
# ---------------------------------------------------------------------------

def indicator_symbols() -> list[str]:
    """
    경제지표 조회가 요청하는 심볼 유니버스 / The indicator symbol universe one fetch requests.

    공개 이유는 `index_symbols`와 같다 (호출부의 커버리지 판정용 이음새).
    Public for the same reason as `index_symbols`: the caller's coverage seam.
    """
    return list(config.INDICATORS)


def fetch_indicators() -> list[Indicator]:
    """
    환율/금리/원자재 등 경제지표를 한 번의 일괄 다운로드로 조회 / Fetch economic indicators in one batch download.

    심볼당 요청 1건을 순차로 내고 dropna로 휴장일 NaN 행을 흡수한다 (`fetch_indices`와 동일한 규약).
    One serial request per symbol, with dropna absorbing holiday NaN rows (same contract as `fetch_indices`).

    `INDICATOR_FETCH_DEADLINE`이 만료되면 남은 심볼을 포기하고 파싱된 행만 반환한다 (예외 없음).
    On `INDICATOR_FETCH_DEADLINE` expiry the remaining symbols are dropped and the parsed rows returned.

    Returns:
        Indicator 리스트 (실패·예산 초과 심볼은 제외) / List of Indicator (failed and unbudgeted symbols omitted).
    """
    symbols = indicator_symbols()  # 커버리지 판정과 같은 목록 / the very list the coverage gate counts
    results: list[Indicator] = []

    frames = _serial_frames(
        symbols, INDICATOR_PERIOD, _now() + INDICATOR_FETCH_DEADLINE,
        deadline_event="indicators_deadline_reached",
        failure_event="indicator_download_failed",
        parsed_so_far=results,
    )
    for symbol, frame in frames:
        try:
            name, unit = config.INDICATORS[symbol]
            sub = _sub_frame(frame, symbol, 1)
            if sub is None:
                _warn("indicator_data_missing", symbol=symbol)
                continue

            closes = _valid_closes(sub)
            if closes.empty:
                _warn("indicator_data_missing", symbol=symbol)
                continue

            value = _safe_float(closes.iloc[-1], float("nan"))
            if _isnan(value):
                _warn("indicator_value_unavailable", symbol=symbol)
                continue
            prev = _safe_float(closes.iloc[-2], value) if len(closes) > 1 else value
            change, pct = _change(value, prev)

            results.append(
                Indicator(
                    symbol=symbol,
                    name=name,
                    value=value,
                    change=change,
                    change_pct=pct,
                    unit=unit,
                )
            )
        except Exception as exc:
            _warn("indicator_parse_failed", symbol=symbol, error=str(exc))

    return results


# ---------------------------------------------------------------------------
# 시세 / Quotes
# ---------------------------------------------------------------------------

def _parse_quotes(
    df,
    symbols: Sequence[str],
    market: str,
    currency: str,
    names: dict,
    sectors: dict,
) -> list[Quote]:
    """
    다운로드된 프레임을 Quote 리스트로 파싱 / Parse a downloaded frame into a list of Quote.

    market_cap은 `yf.download`로 얻을 수 없으므로 항상 None이다 (B6 fundamentals / `fetch_market_caps`가 채운다).
    market_cap is always None here because `yf.download` cannot provide it (filled by B6 / `fetch_market_caps`).
    """
    quotes: list[Quote] = []
    for symbol in symbols:
        try:
            sub = _sub_frame(df, symbol, len(symbols))
            if sub is None:
                _warn("quote_data_missing", symbol=symbol, market=market)
                continue

            # 최신 행(거래량 포함)과 전일 행 / Latest row (carries volume) and previous row
            latest = sub.iloc[-1]
            prev_row = sub.iloc[-2] if len(sub) > 1 else latest
            price = _safe_float(latest["Close"])
            if price == 0:
                _warn("quote_price_unavailable", symbol=symbol, market=market)
                continue
            prev_close = _safe_float(prev_row["Close"], price)
            change, pct = _change(price, prev_close)

            quotes.append(
                Quote(
                    symbol=symbol,
                    name=names.get(symbol, symbol),
                    price=price,
                    change=change,
                    change_pct=pct,
                    volume=_safe_int(latest.get("Volume", 0)),
                    market=market,
                    currency=currency,
                    sector=sectors.get(symbol, ""),
                    market_cap=None,
                )
            )
        except Exception as exc:
            _warn("quote_parse_failed", symbol=symbol, market=market, error=str(exc))

    return quotes


def _retry_delay(remaining: float) -> float:
    """
    남은 예산 안에서 지터 백오프를 뽑는다 / Draw a jittered backoff that fits the remaining budget.

    Args:
        remaining: 데드라인까지 남은 초 / Seconds left until the deadline.
    """
    low, high = QUOTE_RETRY_BACKOFF
    return max(0.0, min(random.uniform(low, high), remaining))


def _quote_pass(
    symbols: Sequence[str],
    market: str,
    currency: str,
    names: dict,
    sectors: dict,
    deadline: float,
    attempt: str,
) -> Dict[str, Quote]:
    """
    심볼별 순차 요청 한 패스 / One serial pass of per-symbol requests.

    지수·지표와 같은 `_serial_frames` 규율을 쓴다 (심볼당 요청 1건 + 요청 사이 데드라인 확인).
    Uses the same `_serial_frames` discipline as indices and indicators: one request per symbol with
    the deadline checked between requests.

    Args:
        symbols: 이 패스에서 요청할 심볼 / Symbols to request in this pass.
        deadline: `_now()` 기준 종료 시각 — 지나면 새 요청을 내지 않는다 / `_now()`-based cutoff.
        attempt: 로그용 패스 이름 ("primary"/"retry") / Pass name for logs.

    Returns:
        {심볼: Quote} - 실패하거나 가격이 없는 심볼은 빠진다 / {symbol: Quote}; failures and priceless symbols absent.
    """
    parsed: Dict[str, Quote] = {}
    frames = _serial_frames(
        symbols, QUOTE_PERIOD, deadline,
        deadline_event="quote_deadline_reached",
        failure_event="quote_download_failed",
        parsed_so_far=parsed,
        market=market, attempt=attempt,
    )
    for symbol, frame in frames:
        for quote in _parse_quotes(frame, [symbol], market, currency, names, sectors):
            parsed[quote.symbol] = quote
    return parsed


def _quote_budget(symbol_count: int) -> float:
    """
    심볼 수에 비례한 시세 조회 예산(초), 상한 클램프 / Symbol-proportional quote budget in seconds, clamped.

    산술 근거는 `QUOTE_BUDGET_PER_SYMBOL` / `QUOTE_FETCH_DEADLINE_MAX` 주석 참조.
    See the `QUOTE_BUDGET_PER_SYMBOL` / `QUOTE_FETCH_DEADLINE_MAX` comments for the arithmetic.
    """
    return min(QUOTE_BUDGET_PER_SYMBOL * symbol_count, QUOTE_FETCH_DEADLINE_MAX)


def market_symbols(market: Literal["us", "kr"]) -> list[str]:
    """
    한 시장의 요청 대상 심볼 유니버스 / The symbol universe one market's quote fetch requests.

    호출부(라우트·스케줄러)가 커버리지(반환 시세 수 / 요청 심볼 수)를 직접 계산해 부분 성공을
    `/api/health`에 드러낼 수 있도록 공개한다. `fetch_quotes`를 AppState와 결합시키지 않고 부분
    성공을 관측 가능하게 만드는 이음새다 — 서비스는 순수하게 유지한다.
    Public so callers (routes and the scheduler) can compute coverage themselves - returned quotes over
    requested symbols - and surface a partial in `/api/health`. This is the seam that makes a partial
    observable without coupling `fetch_quotes` to AppState; the service stays pure.

    Args:
        market: "us" 또는 "kr" / "us" or "kr".

    Raises:
        ValueError: 지원하지 않는 market / Unsupported market argument.
    """
    if market not in _MARKETS:
        raise ValueError(f"unsupported market: {market!r} (expected 'us' or 'kr')")
    return list(getattr(config, _MARKETS[market][0]))


def fetch_quotes(market: Literal["us", "kr"]) -> list[Quote]:
    """
    시장 전체 종목 시세를 심볼별 순차 요청으로 조회 / Fetch a market's quotes with serial per-symbol requests.

    전략 (2026-08-04 라이브 장애 이후) / Strategy (after the 2026-08-04 live incident):
      1. 1차 패스: config 심볼 순서대로 심볼당 요청 1건, 순차. 동시성 없음 — Yahoo가 심볼 전부를
         빈 프레임으로 돌려주게 만든 건 배치 크기가 아니라 병렬 버스트(10심볼×5워커)였다.
         Primary pass: one request per symbol, serial, in config order. No concurrency: what made
         Yahoo answer with all-empty frames was the parallel burst (10 symbols × 5 workers), not size.
      2. 재시도 패스: 빠진 심볼만 한 번 더 (지터 백오프 후, 예산이 남아 있을 때만). 전체 재실행은
         이미 받은 심볼까지 두 번 때리므로 하지 않는다.
         Retry pass: only the missing symbols, once, after a jittered backoff and only while budget
         remains; re-running everything would hit the already-parsed symbols twice.
      3. 커버리지 판정: 파싱 성공/요청 비율이 `QUOTE_MIN_COVERAGE` 이상이면 부분 결과를 반환하고
         경고, 미달이면 `QuotesUnavailableError`.
         Coverage gate: at or above `QUOTE_MIN_COVERAGE` the partial result is returned with a
         warning; below it, `QuotesUnavailableError`.
      4. 전체 예산 = `_quote_budget(심볼 수)`: 만료되면 새 요청을 내지 않고 가진 것으로 판정한다.
         진행 중인 요청 1건은 예산 밖이다 (`DOWNLOAD_TIMEOUT` 주석의 crumb 주의사항 참조).
         `_quote_budget(symbol count)` caps the whole sequence: on expiry no new request is issued and
         what we have is evaluated. One in-flight request sits outside the budget (see the crumb
         caveat next to `DOWNLOAD_TIMEOUT`).

    Args:
        market: "us" 또는 "kr" / "us" or "kr"

    Returns:
        Quote 리스트 (config 심볼 순서 유지, 실패 심볼은 제외)
        List of Quote in config symbol order; failed symbols are omitted.

    Raises:
        ValueError: 지원하지 않는 market / Unsupported market argument.
        QuotesUnavailableError: 전 심볼이 비었거나 커버리지가 `QUOTE_MIN_COVERAGE` 미달 - 빈/심하게
            부족한 결과가 "성공"으로 캐시되어 마지막 정상 시세를 밀어내는 것을 막는다.
            All symbols empty, or coverage below `QUOTE_MIN_COVERAGE`; keeps an empty or severely
            partial result from being cached as "success" and evicting the last good quotes.
    """
    symbols = market_symbols(market)  # 지원하지 않는 market은 여기서 ValueError / raises for a bad market
    _symbols_attr, names_attr, sectors_attr, currency = _MARKETS[market]
    names = getattr(config, names_attr)
    sectors = getattr(config, sectors_attr)
    if not symbols:
        return []

    deadline = _now() + _quote_budget(len(symbols))
    parsed = _quote_pass(symbols, market, currency, names, sectors, deadline, "primary")

    missing = [symbol for symbol in symbols if symbol not in parsed]
    if missing:
        remaining = deadline - _now()
        if remaining > 0:
            # 지연은 동기 sleep이다 — 호출부가 `asyncio.to_thread`로 감싸므로 이벤트 루프는 막히지 않는다
            # A synchronous sleep: callers wrap this in `asyncio.to_thread`, so the event loop is safe
            time.sleep(_retry_delay(remaining))
            parsed.update(_quote_pass(missing, market, currency, names, sectors, deadline, "retry"))
            missing = [symbol for symbol in symbols if symbol not in parsed]
        else:
            _warn("quote_retry_skipped", market=market, missing=len(missing), reason="deadline")

    quotes: List[Quote] = [parsed[symbol] for symbol in symbols if symbol in parsed]
    coverage = len(quotes) / len(symbols)

    # 빈/심하게 부족한 결과는 성공이 아니라 실패다: 그대로 캐시에 저장되면 마지막 정상 데이터를
    # 밀어내고 stale-while-error가 무력화된다 (2026-08-04 장애의 2차 원인 — US 목록이 빈 화면이 됐다).
    # 예외로 승격하면 `deps.cached`의 stale 폴백이 마지막 정상 시세를 계속 서빙한다.
    # An empty or severely partial result is a failure, not a success: cached as "success" it evicts
    # the last good data and disarms stale-while-error (the 2026-08-04 incident's second cause — a
    # blank US table). Raising lets `deps.cached`'s stale fallback keep serving the last good quotes.
    if not quotes:
        _warn("quotes_empty", market=market, symbols=len(symbols))
        raise QuotesUnavailableError(f"no quotes for market {market!r} ({len(symbols)} symbols)")
    if coverage < QUOTE_MIN_COVERAGE:
        _warn(
            "quotes_coverage_too_low",
            market=market, parsed=len(quotes), requested=len(symbols),
            coverage=round(coverage, 3), minimum=QUOTE_MIN_COVERAGE,
        )
        raise QuotesUnavailableError(
            f"quote coverage {len(quotes)}/{len(symbols)} below {QUOTE_MIN_COVERAGE:.0%} "
            f"for market {market!r}"
        )
    if missing:
        _warn(
            "quotes_partial",
            market=market, parsed=len(quotes), requested=len(symbols),
            missing=len(missing), coverage=round(coverage, 3),
        )
    return quotes


# ---------------------------------------------------------------------------
# 시가총액 / Market caps
# ---------------------------------------------------------------------------

def _read_market_cap(fast_info: Any) -> Optional[float]:
    """
    fast_info에서 market_cap 추출 (dict/속성 접근 모두 지원) / Read market_cap from fast_info (mapping or attribute).
    """
    try:
        cap = fast_info["market_cap"]
    except (TypeError, KeyError, IndexError, AttributeError):
        cap = getattr(fast_info, "market_cap", None)
    return cap


def _fetch_market_cap(symbol: str) -> Optional[float]:
    """개별 종목 시가총액 조회 / Fetch a single symbol's market cap."""
    cap = _read_market_cap(yf.Ticker(symbol).fast_info)
    if cap is None:
        return None
    value = _safe_float(cap)
    return value or None


def fetch_market_caps(symbols: Iterable[str]) -> dict[str, float]:
    """
    `Ticker.fast_info`로 시가총액을 병렬 조회 / Fetch market caps in parallel via `Ticker.fast_info`.

    `yf.download`는 시가총액을 주지 않으므로 대시보드 테이블용으로 별도 조회한다.
    `yf.download` does not expose market cap, so the dashboard table fetches it separately.

    Args:
        symbols: 종목 심볼 목록 / Symbols to look up.

    Returns:
        {심볼: 시가총액} - 실패/미제공 심볼은 제외 / {symbol: market_cap}, failures and blanks omitted.
    """
    wanted = list(symbols)
    if not wanted:
        return {}

    result: dict[str, float] = {}
    unavailable: list[str] = []
    errored: set = set()

    with ThreadPoolExecutor(max_workers=MARKET_CAP_WORKERS) as pool:
        futures = {pool.submit(_fetch_market_cap, symbol): symbol for symbol in wanted}
        try:
            for future in as_completed(futures, timeout=MARKET_CAP_TIMEOUT):
                symbol = futures[future]
                try:
                    cap = future.result()
                except Exception as exc:
                    errored.add(symbol)
                    _warn("market_cap_failed", symbol=symbol, error=str(exc))
                    continue
                if cap:
                    result[symbol] = cap
                else:
                    unavailable.append(symbol)
        except Exception as exc:
            _warn("market_cap_timeout", completed=len(result), error=str(exc))

    if unavailable:
        # 예외 없이 값이 비어 온 심볼은 한 줄로 요약 / Symbols that returned no value are summarized in one line
        _warn("market_cap_unavailable", symbols=unavailable, count=len(unavailable))
    return result
