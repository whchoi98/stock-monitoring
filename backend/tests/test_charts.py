"""
차트 서비스 테스트 - 순수 로직(MA/크로스) + yfinance monkeypatch (실제 네트워크 호출 없음)
Chart service tests - pure logic (MA/cross) plus monkeypatched yfinance (no real network calls).
"""
import json
import logging

import pandas as pd
import pytest

from app.core import config
from app.services import charts
from app.services.charts import compute_ma, find_crosses

LOGGER_NAME = "app.services.charts"


# ---------------------------------------------------------------------------
# Fake yfinance Ticker / 가짜 yfinance Ticker
# ---------------------------------------------------------------------------

def _history_frame(closes, index=None, freq="D", volumes=None):
    """고정 history DataFrame 빌더 (OHLCV) / Fixed history DataFrame builder (OHLCV)."""
    n = len(closes)
    if index is None:
        index = pd.date_range("2026-01-01", periods=n, freq=freq)
    return pd.DataFrame(
        {
            "Open": [c - 0.5 for c in closes],
            "High": [c + 1.0 for c in closes],
            "Low": [c - 1.0 for c in closes],
            "Close": list(closes),
            "Volume": list(volumes) if volumes is not None else [1000.0 + i for i in range(n)],
        },
        index=index,
    )


def _patch_ticker(monkeypatch, frame=None, error=None):
    """yf.Ticker를 고정 history로 대체하고 호출 인자를 기록 / Replace yf.Ticker with a fixed history, recording calls."""
    calls = []

    class FakeTicker:
        def __init__(self, symbol):
            self.symbol = symbol

        def history(self, period=None, interval=None, **kwargs):
            calls.append({"symbol": self.symbol, "period": period, "interval": interval})
            if error is not None:
                raise error
            return frame if frame is not None else _history_frame([])

    monkeypatch.setattr(charts.yf, "Ticker", FakeTicker)
    return calls


def _warning_payloads(caplog):
    """경고 로그가 모두 단일 라인 JSON임을 확인하고 파싱 / Assert single-line JSON warnings and parse them."""
    payloads = []
    for record in caplog.records:
        message = record.getMessage()
        assert "\n" not in message  # 단일 라인 JSON / single-line JSON
        payloads.append(json.loads(message))
    return payloads


# ---------------------------------------------------------------------------
# Brief Step 1: 순수 로직 / pure logic
# ---------------------------------------------------------------------------

def test_compute_ma():
    assert compute_ma([1, 2, 3, 4], 3) == [None, None, 2.0, 3.0]


def test_golden_and_dead_cross():
    ma5 = [None, 1.0, 2.0, 3.0, 1.0]
    ma20 = [None, 1.5, 1.5, 1.5, 1.5]
    t = ["a", "b", "c", "d", "e"]
    sigs = find_crosses(ma5, ma20, t)
    assert [(s.time, s.kind) for s in sigs] == [("c", "golden"), ("e", "dead")]


# ---------------------------------------------------------------------------
# compute_ma
# ---------------------------------------------------------------------------

def test_compute_ma_pads_window_minus_one_and_keeps_length():
    """앞쪽 window-1개는 None이고 길이는 입력과 동일 / First window-1 entries are None; length matches input."""
    closes = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0]
    out = compute_ma(closes, 5)
    assert len(out) == len(closes)
    assert out[:4] == [None, None, None, None]
    assert out[4] == pytest.approx(30.0)   # (10+20+30+40+50)/5
    assert out[5] == pytest.approx(40.0)   # (20+30+40+50+60)/5


def test_compute_ma_window_one_returns_copy_of_closes():
    """window=1이면 종가 그대로 / window=1 mirrors the closes."""
    assert compute_ma([1.5, 2.5], 1) == [1.5, 2.5]


def test_compute_ma_window_longer_than_input_is_all_none():
    """데이터가 window보다 짧으면 전부 None / All None when data is shorter than the window."""
    assert compute_ma([1.0, 2.0], 20) == [None, None]


def test_compute_ma_empty_input():
    assert compute_ma([], 5) == []


def test_compute_ma_rejects_non_positive_window():
    """window <= 0은 ValueError / Non-positive window raises ValueError."""
    with pytest.raises(ValueError):
        compute_ma([1.0, 2.0], 0)


# ---------------------------------------------------------------------------
# find_crosses
# ---------------------------------------------------------------------------

def test_find_crosses_skips_none_at_current_or_previous_index():
    """현재 또는 직전 인덱스에 None이 있으면 skip / Skip when either MA is None at current or previous index."""
    #            0     1     2     3     4     5
    ma5 = [None, 1.0, None, 3.0, 1.0, 5.0]
    ma20 = [1.5, 1.5, 1.5, 1.5, 1.5, 1.5]
    times = list("abcdef")

    # i=1: ma5[0] is None -> skip, i=2: ma5[2] is None -> skip,
    # i=3: prev None -> skip, i=4: 3.0->1.0 dead, i=5: 1.0->5.0 golden
    sigs = find_crosses(ma5, ma20, times)
    assert [(s.time, s.kind) for s in sigs] == [("e", "dead"), ("f", "golden")]


def test_find_crosses_no_signal_when_no_side_change():
    """교차가 없으면 신호 없음 / No crossing means no signal."""
    ma5 = [1.0, 2.0, 3.0, 4.0]
    ma20 = [0.5, 0.5, 0.5, 0.5]
    assert find_crosses(ma5, ma20, list("abcd")) == []


def test_find_crosses_touch_then_break_upward_is_golden():
    """직전이 같아도(ma5<=ma20) 위로 벌어지면 golden / Equality at prev still yields golden on break upward."""
    ma5 = [2.0, 1.5, 2.0]
    ma20 = [1.5, 1.5, 1.5]
    sigs = find_crosses(ma5, ma20, list("abc"))
    assert [(s.time, s.kind) for s in sigs] == [("c", "golden")]


def test_find_crosses_empty_inputs():
    assert find_crosses([], [], []) == []


# ---------------------------------------------------------------------------
# Brief Step 5: fetch_chart (yf.Ticker monkeypatch)
# ---------------------------------------------------------------------------

def test_fetch_chart_period_mapping(monkeypatch):
    """period -> (yf period, interval) 매핑을 그대로 사용 / period maps to the exact yf period/interval pair."""
    expected = {"1w": ("7d", "1h"), "1m": ("1mo", "1d"), "3m": ("3mo", "1d"), "1y": ("1y", "1d")}
    calls = _patch_ticker(monkeypatch, _history_frame([10.0, 11.0, 12.0]))

    for period, (yf_period, interval) in expected.items():
        charts.fetch_chart("AAPL", period)
        assert calls[-1] == {"symbol": "AAPL", "period": yf_period, "interval": interval}

    assert set(charts.PERIOD_MAP) == set(expected)
    # 유효 period는 캐시 TTL 설정과 동일해야 한다 / Valid periods must match the cache TTL config
    assert set(charts.PERIOD_MAP) == set(config.CHART_TTL)


def test_fetch_chart_candles_and_ma_align_one_to_one(monkeypatch):
    """캔들 수 == ma5 길이 == ma20 길이, 앞쪽은 None 패딩 / Candle count equals both MA lengths, front-padded with None."""
    closes = [100.0 + i for i in range(30)]
    _patch_ticker(monkeypatch, _history_frame(closes))

    out = charts.fetch_chart("AAPL", "1m")

    assert out.symbol == "AAPL"
    assert out.period == "1m"                      # 요청 period를 그대로 반영 / echoes the requested period
    assert len(out.candles) == 30
    assert len(out.ma5) == len(out.candles)
    assert len(out.ma20) == len(out.candles)
    assert out.ma5[:4] == [None] * 4
    assert out.ma5[4] == pytest.approx(102.0)      # mean(100..104)
    assert out.ma20[:19] == [None] * 19
    assert out.ma20[19] == pytest.approx(109.5)    # mean(100..119)


def test_fetch_chart_candle_fields_from_ohlcv(monkeypatch):
    """캔들 OHLCV가 history 컬럼과 일치 / Candle OHLCV mirrors the history columns."""
    _patch_ticker(monkeypatch, _history_frame([50.0, 51.0], volumes=[1234.0, 5678.0]))

    candle = charts.fetch_chart("MSFT", "3m").candles[0]
    assert candle.time == "2026-01-01"
    assert candle.open == pytest.approx(49.5)
    assert candle.high == pytest.approx(51.0)
    assert candle.low == pytest.approx(49.0)
    assert candle.close == pytest.approx(50.0)
    assert candle.volume == 1234


def test_fetch_chart_daily_interval_uses_date_only_time(monkeypatch):
    """일봉 이상 간격은 YYYY-MM-DD / Daily (and coarser) intervals use YYYY-MM-DD."""
    _patch_ticker(monkeypatch, _history_frame([10.0, 11.0, 12.0]))
    out = charts.fetch_chart("AAPL", "1y")
    assert [c.time for c in out.candles] == ["2026-01-01", "2026-01-02", "2026-01-03"]


def test_fetch_chart_hourly_interval_uses_iso_minutes(monkeypatch):
    """1w(1h 간격)은 ISO 분 단위 / The 1w period (1h interval) uses ISO minute precision."""
    index = pd.date_range("2026-01-05 09:30", periods=3, freq="h")
    _patch_ticker(monkeypatch, _history_frame([10.0, 11.0, 12.0], index=index))

    out = charts.fetch_chart("AAPL", "1w")
    assert [c.time for c in out.candles] == [
        "2026-01-05T09:30",
        "2026-01-05T10:30",
        "2026-01-05T11:30",
    ]


def test_fetch_chart_rejects_unknown_period(monkeypatch):
    """유효하지 않은 period는 ValueError (라우트가 422로 매핑) / Invalid period raises ValueError (route maps it to 422)."""
    def boom(symbol):
        raise AssertionError("must not call yfinance for an invalid period")

    monkeypatch.setattr(charts.yf, "Ticker", boom)
    with pytest.raises(ValueError):
        charts.fetch_chart("AAPL", "5y")


def test_fetch_chart_skips_nan_close_rows(monkeypatch):
    """종가가 NaN인 행은 제외하고 MA 길이도 함께 줄어든다 / NaN close rows are dropped; MA lengths follow."""
    closes = [10.0, float("nan"), 12.0, 13.0, 14.0, 15.0]
    _patch_ticker(monkeypatch, _history_frame(closes))

    out = charts.fetch_chart("AAPL", "1m")
    assert len(out.candles) == 5
    assert [c.close for c in out.candles] == [10.0, 12.0, 13.0, 14.0, 15.0]
    assert len(out.ma5) == 5 and len(out.ma20) == 5
    assert out.ma5[4] == pytest.approx(12.8)   # mean(10,12,13,14,15)
    assert out.ma20 == [None] * 5


def test_fetch_chart_detects_golden_cross(monkeypatch):
    """하락 후 급등 시 골든 크로스 1건 / A sharp rally after a downtrend yields exactly one golden cross."""
    closes = [100.0 - i for i in range(20)] + [200.0] * 5   # index 20에서 교차 / cross at index 20
    _patch_ticker(monkeypatch, _history_frame(closes))

    out = charts.fetch_chart("AAPL", "1y")
    assert [(s.time, s.kind) for s in out.signals] == [("2026-01-21", "golden")]


def test_fetch_chart_empty_history_warns_and_raises(monkeypatch, caplog):
    """빈 history는 조용히 넘기지 않고 경고 + 예외 / Empty history warns and raises instead of failing silently."""
    _patch_ticker(monkeypatch, _history_frame([]))

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        with pytest.raises(RuntimeError):
            charts.fetch_chart("AAPL", "1m")

    payloads = _warning_payloads(caplog)
    assert any(p.get("symbol") == "AAPL" and p.get("period") == "1m" for p in payloads)


def test_fetch_chart_history_failure_warns_and_propagates(monkeypatch, caplog):
    """yfinance 예외는 경고 후 그대로 전파 (캐시가 stale 폴백) / yfinance errors are logged then propagated (cache falls back to stale)."""
    _patch_ticker(monkeypatch, error=RuntimeError("history boom"))

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        with pytest.raises(RuntimeError, match="history boom"):
            charts.fetch_chart("AAPL", "1w")

    payloads = _warning_payloads(caplog)
    assert any("history boom" in p.get("error", "") for p in payloads)
