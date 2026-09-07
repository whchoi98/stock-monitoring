"""
차트 서비스 - yfinance 히스토리를 캔들 + 이동평균(5/20) + 골든/데드 크로스로 변환
Chart service - turns yfinance history into candles plus MA(5/20) and golden/dead cross signals.

`compute_ma`/`find_crosses`는 네트워크와 무관한 순수 함수다 (단위 테스트 대상).
`compute_ma`/`find_crosses` are pure functions with no network involvement (unit-tested directly).

모든 함수는 동기다 (yfinance가 동기) — 호출부에서 `asyncio.to_thread`로 감쌀 것.
All functions are synchronous (yfinance is): wrap them in `asyncio.to_thread` at the call site.
"""
from __future__ import annotations

import json
import logging
import math
from typing import Any, Literal, Optional, Sequence

import yfinance as yf

from app.models import Candle, ChartResponse, CrossSignal
from app.services.market_data import _safe_float, _safe_int

logger = logging.getLogger(__name__)

# 이동평균 윈도우 / Moving average windows
MA_SHORT = 5
MA_LONG = 20

# API period -> (yfinance period, yfinance interval)
PERIOD_MAP = {
    "1w": ("7d", "1h"),
    "1m": ("1mo", "1d"),
    "3m": ("3mo", "1d"),
    "6m": ("6mo", "1d"),
    "1y": ("1y", "1d"),
    # 5년은 주봉 — 일봉 5년(≈1,260 캔들)은 응답 크기와 MA5/MA20의 의미가 모두 나빠진다.
    # Five years is weekly: daily bars over five years (≈1,260 candles) hurt both the payload and what MA5/MA20 mean.
    "5y": ("5y", "1wk"),
}

# 분/시간 간격은 시각까지 필요하다 (차트 라이브러리는 두 포맷을 모두 소비)
# Intraday intervals need a time component (the chart library consumes both formats).
INTRADAY_INTERVALS = {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h"}
_INTRADAY_TIME_FORMAT = "%Y-%m-%dT%H:%M"
_DAILY_TIME_FORMAT = "%Y-%m-%d"


# ---------------------------------------------------------------------------
# 유틸리티 / Utilities
# ---------------------------------------------------------------------------

def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


# ---------------------------------------------------------------------------
# 순수 로직: 이동평균 / Pure logic: moving average
# ---------------------------------------------------------------------------

def compute_ma(closes: Sequence[float], window: int) -> list[Optional[float]]:
    """
    단순 이동평균 계산 / Compute the simple moving average.

    Args:
        closes: 종가 시퀀스 / Sequence of closing prices.
        window: 이동평균 윈도우 (양수) / Moving average window (positive).

    Returns:
        입력과 길이가 같은 리스트. 앞쪽 window-1개는 None (데이터 부족).
        A list the same length as the input; the first window-1 entries are None (not enough data).

    Raises:
        ValueError: window가 1보다 작을 때 / When window is smaller than 1.
    """
    if window < 1:
        raise ValueError(f"window must be >= 1, got {window!r}")

    values = list(closes)
    out: list[Optional[float]] = [None] * len(values)
    # 슬라이스 합을 매번 계산한다 (누적합 대비 부동소수 오차 없음, 데이터 길이가 짧아 비용 무시 가능)
    # Sum each slice directly: no floating point drift from a running sum, and the series is short.
    for i in range(window - 1, len(values)):
        out[i] = sum(values[i - window + 1:i + 1]) / window
    return out


# ---------------------------------------------------------------------------
# 순수 로직: 골든/데드 크로스 / Pure logic: golden/dead cross
# ---------------------------------------------------------------------------

def find_crosses(
    ma5: Sequence[Optional[float]],
    ma20: Sequence[Optional[float]],
    times: Sequence[str],
) -> list[CrossSignal]:
    """
    단기/장기 이동평균 교차 지점 탐색 / Find crossings between the short and long moving averages.

    직전 구간 ma5<=ma20 → 현재 ma5>ma20 이면 golden, 반대면 dead.
    golden when prev ma5<=ma20 and current ma5>ma20; dead for the mirror case.

    현재 또는 직전 인덱스의 MA가 하나라도 None이면 해당 위치는 건너뛴다 (워밍업 구간).
    A position is skipped when either MA is None at the current OR previous index (warm-up region).

    Args:
        ma5: 단기 이동평균 (None 패딩 포함) / Short MA (None-padded).
        ma20: 장기 이동평균 (None 패딩 포함) / Long MA (None-padded).
        times: 캔들 시각 라벨 / Candle time labels.

    Returns:
        시간순 CrossSignal 리스트 / CrossSignal list in chronological order.
    """
    length = min(len(ma5), len(ma20), len(times))
    signals: list[CrossSignal] = []

    for i in range(1, length):
        cur_short, cur_long = ma5[i], ma20[i]
        prev_short, prev_long = ma5[i - 1], ma20[i - 1]
        if cur_short is None or cur_long is None or prev_short is None or prev_long is None:
            continue

        if prev_short <= prev_long and cur_short > cur_long:
            signals.append(CrossSignal(time=times[i], kind="golden"))
        elif prev_short >= prev_long and cur_short < cur_long:
            signals.append(CrossSignal(time=times[i], kind="dead"))

    return signals


# ---------------------------------------------------------------------------
# 차트 조회 / Chart fetch
# ---------------------------------------------------------------------------

def _format_time(value: Any, interval: str) -> str:
    """
    캔들 시각 라벨 생성 / Build the candle time label.

    1h 등 분/시간 간격은 ISO `YYYY-MM-DDTHH:MM`, 일봉 이상은 `YYYY-MM-DD`.
    Intraday intervals use ISO `YYYY-MM-DDTHH:MM`; daily and coarser use `YYYY-MM-DD`.
    """
    fmt = _INTRADAY_TIME_FORMAT if interval in INTRADAY_INTERVALS else _DAILY_TIME_FORMAT
    strftime = getattr(value, "strftime", None)
    return strftime(fmt) if strftime is not None else str(value)


def _candles_from_history(hist: Any, interval: str) -> list[Candle]:
    """
    history DataFrame을 Candle 리스트로 변환 / Convert a history DataFrame into Candle objects.

    종가가 NaN인 행(휴장/미체결)은 제외한다. OHL이 결측이면 종가로 대체한다.
    Rows with a NaN close (holidays/no trades) are dropped; missing OHL falls back to the close.
    """
    candles: list[Candle] = []
    for timestamp, row in hist.iterrows():
        close = _safe_float(row.get("Close"), math.nan)
        if math.isnan(close):
            continue
        candles.append(
            Candle(
                time=_format_time(timestamp, interval),
                open=_safe_float(row.get("Open"), close),
                high=_safe_float(row.get("High"), close),
                low=_safe_float(row.get("Low"), close),
                close=close,
                volume=_safe_int(row.get("Volume"), 0),
            )
        )
    return candles


def fetch_chart(symbol: str, period: Literal["1w", "1m", "3m", "6m", "1y", "5y"]) -> ChartResponse:
    """
    종목 차트(캔들 + MA5/MA20 + 크로스 신호) 조회 / Fetch a symbol's chart: candles, MA5/MA20 and cross signals.

    `ma5`/`ma20`은 항상 `candles`와 1:1 길이로 정렬된다 (앞쪽은 None 패딩).
    `ma5`/`ma20` always align 1:1 with `candles` (front-padded with None).

    Args:
        symbol: yfinance 티커 / yfinance ticker.
        period: "1w" | "1m" | "3m" | "6m" | "1y" | "5y".

    Returns:
        ChartResponse.

    Raises:
        ValueError: 지원하지 않는 period (라우트가 422로 매핑) / Unsupported period (route maps it to 422).
        RuntimeError: 데이터가 비어 있을 때 (캐시가 stale 폴백을 시도) / When no usable data came back (cache retries stale).
        Exception: yfinance 호출 예외는 로그 후 그대로 전파 / yfinance errors are logged then propagated.
    """
    if period not in PERIOD_MAP:
        raise ValueError(
            f"unsupported chart period: {period!r} (expected one of {sorted(PERIOD_MAP)})"
        )

    yf_period, interval = PERIOD_MAP[period]
    try:
        hist = yf.Ticker(symbol).history(period=yf_period, interval=interval)
    except Exception as exc:
        # 조용한 실패 금지: 로그 후 전파해 상위 캐시가 stale 폴백을 시도하게 한다
        # No silent failures: log then propagate so the tiered cache can fall back to stale data.
        _warn("chart_history_failed", symbol=symbol, period=period, error=str(exc))
        raise

    candles = _candles_from_history(hist, interval) if not getattr(hist, "empty", True) else []
    if not candles:
        _warn("chart_data_missing", symbol=symbol, period=period, interval=interval)
        raise RuntimeError(f"chart data unavailable for {symbol} ({period})")

    closes = [candle.close for candle in candles]
    times = [candle.time for candle in candles]
    ma5 = compute_ma(closes, MA_SHORT)
    ma20 = compute_ma(closes, MA_LONG)

    return ChartResponse(
        symbol=symbol,
        period=period,
        candles=candles,
        ma5=ma5,
        ma20=ma20,
        signals=find_crosses(ma5, ma20, times),
    )
