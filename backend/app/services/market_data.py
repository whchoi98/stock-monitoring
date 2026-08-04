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
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Iterable, Literal, Optional, Sequence

import yfinance as yf

from app.core import config
from app.models import Indicator, IndexQuote, Quote

logger = logging.getLogger(__name__)


class QuotesUnavailableError(RuntimeError):
    """
    시장 전체 시세 조회가 완전히 비었다 / A market's quote fetch came back completely empty.

    빈 결과를 반환(=성공)하는 대신 이 예외를 던져야 `deps.cached`의 stale-while-error 폴백이
    마지막 정상 데이터를 계속 서빙한다 (2026-08-04 라이브 장애 교훈).
    Raised instead of returning an empty list so `deps.cached`'s stale-while-error fallback keeps
    serving the last good data (lesson from the 2026-08-04 live incident).
    """

# 지수/지표 조회 기간 - 휴장일 NaN 행을 흡수할 만큼 넉넉히 / Period for indices & indicators (absorbs holiday NaN rows)
INDEX_PERIOD = "5d"
INDICATOR_PERIOD = "5d"
# 시세 조회 기간 / Period for quotes
QUOTE_PERIOD = "7d"
# 시세 폴백용 청크 크기 (직렬) — 1차 경로는 시장 전체 단일 배치다 (fetch_quotes 참조, 2026-08-04)
# Chunk size for the serial quotes fallback; the primary path is one whole-market batch (see fetch_quotes)
QUOTE_CHUNK_SIZE = 10
# 폴백 청크 사이 지연(초) / Delay between fallback chunks in seconds
QUOTE_CHUNK_DELAY = 1.0
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


def _download(symbols: Sequence[str], period: str):
    """yfinance 일괄 다운로드 (모든 호출 경로가 동일한 인자를 쓰도록 단일화) / Single yfinance batch download entry point."""
    return yf.download(
        list(symbols),
        period=period,
        group_by="ticker",
        threads=False,
        progress=False,
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


def fetch_quotes(market: Literal["us", "kr"]) -> list[Quote]:
    """
    시장 전체 종목 시세를 청크 병렬 다운로드로 조회 / Fetch a market's quotes via chunked parallel download.

    Args:
        market: "us" 또는 "kr" / "us" or "kr"

    Returns:
        Quote 리스트 (config 심볼 순서 유지, 실패 심볼/청크는 제외)
        List of Quote in config symbol order; failed symbols and chunks are omitted.

    Raises:
        ValueError: 지원하지 않는 market / Unsupported market argument.
    """
    if market not in _MARKETS:
        raise ValueError(f"unsupported market: {market!r} (expected 'us' or 'kr')")

    symbols_attr, names_attr, sectors_attr, currency = _MARKETS[market]
    symbols = list(getattr(config, symbols_attr))
    names = getattr(config, names_attr)
    sectors = getattr(config, sectors_attr)
    if not symbols:
        return []

    # 1차: 시장 전체 단일 배치 (2026-08-04 라이브 장애 대응). Yahoo가 병렬 청크 버스트(10×5워커)를
    # 심볼 전부 빈 프레임으로 돌려주기 시작했다 — 같은 시점 50심볼 단일 배치는 50/50 성공(실측 2회).
    # 단일 배치는 호출 1회라 레이트리밋 표면도 최소다.
    # Primary path: one whole-market batch (live incident 2026-08-04). Yahoo began answering the
    # parallel chunk burst (10×5 workers) with all-empty frames while a single 50-symbol batch
    # succeeded 50/50 (measured twice). One batch is also the smallest rate-limit surface.
    quotes: list[Quote] = []
    try:
        frame = _download(symbols, QUOTE_PERIOD)
        quotes = _parse_quotes(frame, symbols, market, currency, names, sectors)
    except Exception as exc:
        _warn("quote_batch_failed", market=market, error=str(exc))

    # 폴백: 직렬 청크 — 배치가 통째로 죽거나 전부 비었을 때만. 직렬인 이유: 병렬 버스트가 바로
    # 위 장애의 원인이었다.
    # Fallback: serial chunks, only when the batch died or came back empty. Serial on purpose —
    # the parallel burst is exactly what triggered the incident above.
    if not quotes:
        chunks = [
            symbols[i:i + QUOTE_CHUNK_SIZE]
            for i in range(0, len(symbols), QUOTE_CHUNK_SIZE)
        ]
        for index, chunk in enumerate(chunks):
            if index > 0:
                # 청크 사이 지연 — Yahoo의 빈도 기반 스로틀을 자극하지 않는다 (동기 함수: 호출부가
                # to_thread로 감싸므로 이벤트 루프는 안 막힌다)
                # Inter-chunk delay so the fallback doesn't poke Yahoo's frequency throttle (sync
                # function: callers wrap it in to_thread, so the event loop never blocks)
                time.sleep(QUOTE_CHUNK_DELAY)
            try:
                frame = _download(chunk, QUOTE_PERIOD)
                quotes.extend(_parse_quotes(frame, chunk, market, currency, names, sectors))
            except Exception as exc:
                # 한 청크 실패가 전체 폴백을 죽이지 않는다 / One bad chunk must not kill the fallback
                _warn("quote_chunk_failed", market=market, chunk=index, symbols=chunk, error=str(exc))

    # 전 심볼 빈 결과는 성공이 아니라 실패다: 빈 리스트가 캐시에 저장되면 마지막 정상 데이터를
    # 밀어내고 stale-while-error가 무력화된다 (이번 장애의 2차 원인 — US 목록이 빈 화면이 됐다).
    # 예외로 승격하면 `deps.cached`의 stale 폴백이 마지막 정상 시세를 계속 서빙한다.
    # An all-empty result is a failure, not a success: cached as "success" it evicts the last good
    # data and disarms stale-while-error (the incident's second cause — a blank US table). Raising
    # lets `deps.cached`'s stale fallback keep serving the last good quotes.
    if not quotes:
        _warn("quotes_empty", market=market, symbols=len(symbols))
        raise QuotesUnavailableError(f"no quotes for market {market!r} ({len(symbols)} symbols)")
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
