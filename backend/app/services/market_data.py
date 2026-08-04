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
from typing import Any, Dict, Iterable, List, Literal, Optional, Sequence

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

# `fetch_quotes` 한 호출의 전체 벽시계 예산(초) / Total wall-clock budget for one `fetch_quotes` call.
#
# 예산 산술 / Budget arithmetic:
#   - 요청 1건 상한 = DOWNLOAD_TIMEOUT(8s). 심볼 50개면 1차 패스만으로도 50×8 = 400s가 가능하고
#     재시도까지 더하면 그 두 배다. `fetch_quotes`는 `asyncio.to_thread`(공용 기본 executor)에서
#     돌기 때문에 총 데드라인이 없으면 워커가 분 단위로 묶인다.
#   - CloudFront 오리진 read timeout = 60s (infra `read_timeout`). `/api/market/overview`는 한
#     요청에서 두 시장을 조회할 수 있으므로 25×2 = 50s < 60s 여야 지수·지표 몫도 남는다.
#   - 스케줄러 장중 사이클 = 45s (config.REFRESH_INTERVAL). 시장 1개 = 25s < 45s.
#     (스케줄러는 두 시장을 순차로 조회하므로 최악의 경우 사이클이 밀린다 — 대기가 갱신 *뒤*라
#      사이클이 겹치지는 않는다.)
#   - Per-request cap is 8s; a 50-symbol primary pass alone could reach 400s, doubled with the retry,
#     and this runs on the shared default executor, so the total deadline is what frees the worker.
#     CloudFront's origin read timeout is 60s and the overview route may fetch both markets in one
#     request (25×2 = 50s < 60s, leaving room for indices/indicators). The scheduler's in-hours cycle
#     is 45s, so one market at 25s fits; two markets slip the cycle rather than overlap it, because
#     the loop waits *after* the refresh.
QUOTE_FETCH_DEADLINE = 25

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

def fetch_indices() -> list[IndexQuote]:
    """
    US + KR 주요 지수를 한 번의 일괄 다운로드로 조회 / Fetch US + KR major indices in one batch download.

    KR 지수도 yfinance 심볼(`^KS11`/`^KQ11`)을 사용한다 (pykrx 미사용).
    KR indices also use yfinance symbols (`^KS11`/`^KQ11`); pykrx is not used.

    Returns:
        IndexQuote 리스트 (실패 심볼은 제외) / List of IndexQuote (failed symbols omitted).
    """
    names = {**config.US_INDICES, **config.KR_INDICES}
    symbols = list(names)

    try:
        df = _download(symbols, INDEX_PERIOD)
    except Exception as exc:
        _warn("indices_download_failed", symbols=symbols, error=str(exc))
        return []

    results: list[IndexQuote] = []
    for symbol in symbols:
        try:
            sub = _sub_frame(df, symbol, len(symbols))
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

def fetch_indicators() -> list[Indicator]:
    """
    환율/금리/원자재 등 경제지표를 한 번의 일괄 다운로드로 조회 / Fetch economic indicators in one batch download.

    심볼별 개별 다운로드 대신 일괄 다운로드 + dropna로 NaN 정렬 문제를 피한다.
    Uses a batch download plus dropna instead of per-symbol downloads to avoid NaN alignment issues.

    Returns:
        Indicator 리스트 (실패 심볼은 제외) / List of Indicator (failed symbols omitted).
    """
    symbols = list(config.INDICATORS)

    try:
        df = _download(symbols, INDICATOR_PERIOD)
    except Exception as exc:
        _warn("indicators_download_failed", symbols=symbols, error=str(exc))
        return []

    results: list[Indicator] = []
    for symbol in symbols:
        try:
            name, unit = config.INDICATORS[symbol]
            sub = _sub_frame(df, symbol, len(symbols))
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

    심볼당 `yf.download` 1회다. `threads=False` 배치도 내부적으로는 심볼당 순차 요청이라 Yahoo가
    보는 트래픽은 동일하지만, 이렇게 하면 요청 사이에서 데드라인을 확인할 수 있다 — 배치 호출
    하나는 중간에 끊을 방법이 없다.
    One `yf.download` per symbol. A `threads=False` batch is per-symbol serial requests internally, so
    upstream sees the same traffic, but this way the deadline can be checked between requests: a
    single batch call cannot be interrupted mid-flight.

    Args:
        symbols: 이 패스에서 요청할 심볼 / Symbols to request in this pass.
        deadline: `_now()` 기준 종료 시각 — 지나면 새 요청을 내지 않는다 / `_now()`-based cutoff.
        attempt: 로그용 패스 이름 ("primary"/"retry") / Pass name for logs.

    Returns:
        {심볼: Quote} - 실패하거나 가격이 없는 심볼은 빠진다 / {symbol: Quote}; failures and priceless symbols absent.
    """
    parsed: Dict[str, Quote] = {}
    for issued, symbol in enumerate(symbols):
        if _now() >= deadline:
            # 예산 소진: 남은 심볼은 포기하고 가진 것으로 판정한다 (워커를 붙잡아두지 않는다)
            # Budget spent: give up the rest and evaluate what we have (never hold the worker)
            _warn(
                "quote_deadline_reached",
                market=market, attempt=attempt,
                requested=len(symbols), issued=issued, parsed=len(parsed),
            )
            break
        try:
            frame = _download([symbol], QUOTE_PERIOD)
        except Exception as exc:
            # 한 심볼의 실패가 남은 심볼을 죽이지 않는다 / One symbol's failure must not kill the pass
            _warn("quote_download_failed", market=market, attempt=attempt, symbol=symbol, error=str(exc))
            continue
        for quote in _parse_quotes(frame, [symbol], market, currency, names, sectors):
            parsed[quote.symbol] = quote
    return parsed


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
      4. 전체 예산 `QUOTE_FETCH_DEADLINE`: 만료되면 새 요청을 내지 않고 가진 것으로 판정한다.
         `QUOTE_FETCH_DEADLINE` caps the whole sequence: on expiry no new request is issued and what
         we have is evaluated.

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
    if market not in _MARKETS:
        raise ValueError(f"unsupported market: {market!r} (expected 'us' or 'kr')")

    symbols_attr, names_attr, sectors_attr, currency = _MARKETS[market]
    symbols = list(getattr(config, symbols_attr))
    names = getattr(config, names_attr)
    sectors = getattr(config, sectors_attr)
    if not symbols:
        return []

    deadline = _now() + QUOTE_FETCH_DEADLINE
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
