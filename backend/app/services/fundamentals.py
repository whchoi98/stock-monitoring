"""
펀더멘털 서비스 - yfinance `fast_info`/`info`/`history`로 종목 상세(핵심지표·52주 범위·기간수익률) 조회
Fundamentals service - stock detail (key ratios, 52-week range, period returns) via yfinance.

TUI 프로젝트(`stock-on-tui/services/us_stocks.py:fetch_us_stock_detail`)를 포팅하되 두 가지가 다르다:
Ported from the TUI's `fetch_us_stock_detail`, with two differences:
  1. PER/EPS/베타/PBR/배당수익률은 HTML 스크래핑 대신 `Ticker.info`에서 읽는다.
     Ratios come from `Ticker.info` instead of scraping Yahoo Finance HTML.
  2. 가격 이력 배열 대신 기간수익률(1w/1m/3m/1y)만 반환한다 (차트는 B6 `charts.fetch_chart` 담당).
     Period returns replace the raw history arrays (charts are served by `charts.fetch_chart`).

부분 실패는 허용한다: info/history가 실패해도 가격 응답은 유지하고 결측은 None으로 남긴다.
Partial failures are tolerated: an info/history failure still returns prices, leaving gaps as None.

모든 함수는 동기다 (yfinance가 동기) — 호출부에서 `asyncio.to_thread`로 감쌀 것.
All functions are synchronous (yfinance is): wrap them in `asyncio.to_thread` at the call site.
"""
from __future__ import annotations

import json
import logging
import math
from datetime import datetime, timezone
from typing import Any, Optional

import yfinance as yf

from app.core import config
from app.models import StockDetailResponse
from app.services.market_data import _safe_float, _safe_int

logger = logging.getLogger(__name__)

# 기간수익률: 비교 기준이 되는 거래일(봉) 수 / Period returns: trading rows to look back
RETURN_ROWS = {"1w": 5, "1m": 21, "3m": 63, "1y": 250}

# 평균 거래량 계산 구간(봉) / Bars used for the average volume
AVG_VOLUME_BARS = 10

# 한국 종목 접미사 / Korean ticker suffixes
KR_SUFFIXES = (".KS", ".KQ")

# 배당수익률 경고 임계값(%) - 이보다 크면 스케일이 변했다는 신호다 (실 배당수익률은 25%를 넘지 않는다)
# Dividend-yield warning threshold (%): anything above it signals a scale change, since real yields
# do not exceed 25%.
DIVIDEND_YIELD_SANITY_MAX = 25.0

# info 키 -> 응답 필드 / info key -> response field
_RATIO_KEYS = {
    "pe_ratio": "trailingPE",
    "eps": "trailingEps",
    "beta": "beta",
    "pbr": "priceToBook",
    "dividend_yield": "dividendYield",
}


# ---------------------------------------------------------------------------
# 유틸리티 / Utilities
# ---------------------------------------------------------------------------

def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


def _fast_value(source: Any, key: str) -> Any:
    """
    fast_info 값 읽기 (dict 스타일 우선, 속성 접근 폴백) / Read a fast_info value (mapping first, attribute fallback).

    yfinance 버전에 따라 `FastInfo`가 dict 또는 속성 인터페이스만 제공한다.
    Depending on the yfinance version, `FastInfo` exposes only a mapping or only attributes.
    """
    if source is None:
        return None
    try:
        value = source[key]
    except (TypeError, KeyError, IndexError, AttributeError):
        value = getattr(source, key, None)
    return value


def _fast_float(source: Any, key: str) -> float:
    """fast_info 값을 float으로 (결측/NaN은 0.0) / fast_info value as float (0.0 when missing/NaN)."""
    return _safe_float(_fast_value(source, key), 0.0)


def _fast_int(source: Any, key: str) -> int:
    """fast_info 값을 int으로 (결측/NaN은 0) / fast_info value as int (0 when missing/NaN)."""
    return _safe_int(_fast_value(source, key), 0)


def _ratio(info: dict, key: str) -> Optional[float]:
    """
    비율 지표 읽기 - 결측/비유한 값/변환 실패는 None (0.0으로 대체하지 않음).
    Read a ratio metric; missing, non-finite or unparseable values become None (never 0.0).

    유한한 음수와 0은 그대로 유지한다 (예: 적자 종목의 EPS, 무배당 종목의 배당수익률).
    Finite negatives and zero are preserved (e.g. negative EPS or a non-payer's dividend yield).
    """
    value = info.get(key)
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _check_dividend_scale(symbol: str, dividend_yield: Optional[float]) -> None:
    """
    배당수익률이 퍼센트 스케일인지 감시 (값은 바꾸지 않는다) / Watch the dividend-yield scale, without changing the value.

    yfinance는 `dividendYield`를 퍼센트로 준다 (AAPL 0.35 = 0.35%). 라이브러리가 원시 분수로
    바뀌면 값이 100분의 1이 되는데, 그건 조용히 잘못된 화면으로만 드러난다. 반대로 프론트에
    ×100이 다시 들어오거나 소스가 분수→퍼센트로 또 바뀌면 값이 비상식적으로 커진다.
    yfinance reports `dividendYield` in percent (AAPL 0.35 = 0.35%). If the library switched to a raw
    fraction the value would silently shrink a hundredfold; conversely a re-introduced x100 anywhere
    upstream would make it absurdly large.

    25%를 넘는 배당수익률은 현실적으로 거의 불가능하므로 경고를 남긴다 (스케일이 변했다는 신호).
    실패로 처리하지는 않는다: 특별배당·데이터 오류로 진짜 큰 값이 오는 종목도 있고, 화면을 못 그리는
    것보다 이상한 숫자를 보여주고 로그를 남기는 편이 낫다.
    A yield above 25% is practically impossible, so it is logged as a signal that the scale moved. It is
    never treated as a failure: special dividends and upstream data errors do produce genuinely large
    values, and showing an odd number with a log beats refusing to render the page.
    """
    if dividend_yield is not None and dividend_yield > DIVIDEND_YIELD_SANITY_MAX:
        _warn("detail_dividend_yield_out_of_range", symbol=symbol,
              dividend_yield=dividend_yield, expected_max=DIVIDEND_YIELD_SANITY_MAX,
              hint="dividendYield is expected on a percent scale (0.35 = 0.35%)")


def _market_and_currency(symbol: str) -> tuple:
    """심볼 접미사로 시장/통화 판별 / Derive market and currency from the ticker suffix."""
    if symbol.upper().endswith(KR_SUFFIXES):
        return "kr", "KRW"
    return "us", "USD"


# ---------------------------------------------------------------------------
# yfinance 접근 (부분 실패 허용) / yfinance access (partial failures tolerated)
# ---------------------------------------------------------------------------

class _SafeFastInfo:
    """필드 접근 시 생기는 지연 조회 실패를 격리 / Isolate failures triggered by lazy field access."""

    def __init__(self, source: Any, symbol: str, failures: list[str]) -> None:
        self.source = source
        self.symbol = symbol
        self.failures = failures
        self.values: dict[str, Any] = {}

    def __getitem__(self, key: str) -> Any:
        # 필요한 필드만 한 번 읽는다. 실패한 필드 재접근도 업스트림을 재호출하지 않는다.
        # Read only demanded fields, once; accessing a failed field again cannot retry upstream.
        if key not in self.values:
            try:
                self.values[key] = _fast_value(self.source, key)
            except Exception as exc:
                self.values[key] = None
                self.failures.append(f"fast_info.{key}")
                _warn("detail_fast_info_field_failed", symbol=self.symbol, field=key, error=str(exc))
        return self.values[key]


def _read_fast_info(ticker: Any, symbol: str, failures: list[str]) -> Any:
    """fast_info 조회 (실패 시 경고 + None) / Fetch fast_info (warn and return None on failure)."""
    try:
        return _SafeFastInfo(ticker.fast_info, symbol, failures)
    except Exception as exc:
        failures.append("fast_info")
        _warn("detail_fast_info_failed", symbol=symbol, error=str(exc))
        return None


def _read_info(ticker: Any, symbol: str, failures: list[str]) -> dict:
    """info 조회 (실패 시 경고 + 빈 dict) / Fetch info (warn and return an empty dict on failure)."""
    try:
        info = ticker.info
    except Exception as exc:
        failures.append("info")
        _warn("detail_info_failed", symbol=symbol, error=str(exc))
        return {}
    return info if isinstance(info, dict) else {}


def _read_history(ticker: Any, symbol: str, failures: list[str]) -> Any:
    """1년 history 조회 (실패 시 경고 + None) / Fetch the 1-year history (warn and return None on failure)."""
    try:
        return ticker.history(period="1y")
    except Exception as exc:
        failures.append("history")
        _warn("detail_history_failed", symbol=symbol, error=str(exc))
        return None


# ---------------------------------------------------------------------------
# history 파생값 / history-derived values
# ---------------------------------------------------------------------------

def _has_rows(hist: Any) -> bool:
    """history 프레임에 행이 있는지 / Whether the history frame carries any row."""
    return hist is not None and not getattr(hist, "empty", True)


def _valid_closes(hist: Any) -> list:
    """NaN을 제거한 종가 리스트 / Close prices with NaN rows dropped."""
    if not _has_rows(hist) or "Close" not in hist:
        return []
    values = (_safe_float(v, math.nan) for v in hist["Close"].dropna().tolist())
    return [v for v in values if not math.isnan(v)]


def _week52_range(hist: Any, fast_info: Any) -> tuple:
    """
    52주 고저 - history High/Low 우선, 없으면 fast_info year_high/year_low 폴백.
    52-week range - from history High/Low, falling back to fast_info year_high/year_low.
    """
    high = low = 0.0
    if _has_rows(hist):
        if "High" in hist:
            high = _safe_float(hist["High"].max(), 0.0)
        if "Low" in hist:
            low = _safe_float(hist["Low"].min(), 0.0)
    if not high:
        high = _fast_float(fast_info, "year_high")
    if not low:
        low = _fast_float(fast_info, "year_low")
    return high, low


def _avg_volume(hist: Any) -> int:
    """최근 10봉 평균 거래량 (데이터가 짧으면 있는 만큼) / Average volume over the last 10 bars (or fewer)."""
    if not _has_rows(hist) or "Volume" not in hist:
        return 0
    tail = hist["Volume"].dropna().tail(AVG_VOLUME_BARS)
    if tail.empty:
        return 0
    return _safe_int(tail.mean(), 0)


def _period_returns(closes: list) -> dict:
    """
    기간수익률(%) 계산 - 마지막 종가 vs N봉 전 종가 / Period returns (%): last close vs the close N bars back.

    history가 N봉보다 짧으면 사용 가능한 가장 오래된 종가로 클램프한다.
    When the history is shorter than N bars, the lookback clamps to the oldest available close.
    """
    out: dict = {period: None for period in RETURN_ROWS}
    if len(closes) < 2:
        return out

    last = closes[-1]
    for period, rows in RETURN_ROWS.items():
        offset = min(rows, len(closes) - 1)
        base = closes[-1 - offset]
        out[period] = ((last - base) / base * 100) if base else None
    return out


# ---------------------------------------------------------------------------
# 종목 상세 / Stock detail
# ---------------------------------------------------------------------------

def fetch_detail(symbol: str) -> StockDetailResponse:
    """
    종목 상세 조회 (fast_info + info + 1년 history) / Fetch stock detail from fast_info, info and the 1-year history.

    Args:
        symbol: yfinance 티커 (US `AAPL`, KR `005930.KS`/`247540.KQ`) / yfinance ticker.

    Returns:
        StockDetailResponse - 결측 비율 지표는 None, 기간수익률은 `returns` dict.
        StockDetailResponse; missing ratios are None and period returns live in `returns`.

    Raises:
        RuntimeError: fast_info와 history 어디에서도 가격을 얻지 못했을 때 (캐시가 stale 폴백을 시도).
        RuntimeError: When no price is available from either source (the cache then retries stale data).
    """
    ticker = yf.Ticker(symbol)
    failures: list[str] = []
    fast_info = _read_fast_info(ticker, symbol, failures)
    info = _read_info(ticker, symbol, failures)
    hist = _read_history(ticker, symbol, failures)
    closes = _valid_closes(hist)

    if not _has_rows(hist):
        if "history" not in failures:
            failures.append("history")
        _warn("detail_history_missing", symbol=symbol)

    # 가격은 fast_info 우선, 실패 시 history 종가로 복구 / Price from fast_info, recovered from history closes
    price = _fast_float(fast_info, "last_price")
    if not price and closes:
        price = closes[-1]
    if not price:
        _warn("detail_price_unavailable", symbol=symbol)
        raise RuntimeError(f"detail data unavailable for {symbol}")

    prev_close = _fast_float(fast_info, "previous_close")
    if not prev_close and len(closes) > 1:
        prev_close = closes[-2]

    change = price - prev_close if prev_close else 0.0
    change_pct = (change / prev_close * 100) if prev_close else 0.0

    week52_high, week52_low = _week52_range(hist, fast_info)
    market, currency = _market_and_currency(symbol)
    ratios = {field: _ratio(info, key) for field, key in _RATIO_KEYS.items()}
    _check_dividend_scale(symbol, ratios["dividend_yield"])

    detail = StockDetailResponse(
        symbol=symbol,
        name=config.STOCK_NAMES.get(symbol, symbol),
        name_ko=config.STOCK_NAMES_KO.get(symbol),
        market=market,
        currency=currency,
        price=price,
        change=change,
        change_pct=change_pct,
        open_price=_fast_float(fast_info, "open"),
        high=_fast_float(fast_info, "day_high"),
        low=_fast_float(fast_info, "day_low"),
        prev_close=prev_close,
        volume=_fast_int(fast_info, "last_volume"),
        avg_volume=_avg_volume(hist),
        market_cap=_fast_float(fast_info, "market_cap"),
        week52_high=week52_high,
        week52_low=week52_low,
        # day_change는 TUI 모델 호환 필드로, 전일종가 기준 등락과 같은 값이다
        # day_change mirrors the prev-close change; it exists for TUI model compatibility
        day_change=change,
        day_change_pct=change_pct,
        sector=config.STOCK_SECTORS.get(symbol, ""),
        returns=_period_returns(closes),
        last_updated=datetime.now(timezone.utc),
        **ratios,
    )
    detail._source_failures = failures
    return detail
