"""
펀더멘털 서비스 테스트 - yf.Ticker를 FakeTicker로 monkeypatch (실제 네트워크 호출 없음)
Fundamentals service tests - yf.Ticker is monkeypatched with a FakeTicker (no real network calls).
"""
import json
import logging
from datetime import timezone

import pandas as pd
import pytest

from app.core import config
from app.services import fundamentals

LOGGER_NAME = "app.services.fundamentals"

# 기본 fast_info / Baseline fast_info payload
FAST_INFO = {
    "last_price": 110.0,
    "previous_close": 100.0,
    "open": 101.0,
    "day_high": 115.0,
    "day_low": 99.0,
    "market_cap": 3.0e12,
    "last_volume": 5000,
    "year_high": 130.0,
    "year_low": 80.0,
}

# 기본 info / Baseline info payload
# `dividendYield`는 퍼센트 스케일이다 (라이브 Yahoo: AAPL 0.35 = 0.35%) - 원시 분수가 아니다.
# `dividendYield` is percent-scale (live Yahoo: AAPL 0.35 = 0.35%), not a raw fraction.
INFO = {
    "trailingPE": 30.5,
    "trailingEps": 6.1,
    "beta": 1.2,
    "priceToBook": 45.0,
    "dividendYield": 0.35,
}


# ---------------------------------------------------------------------------
# Fake yfinance Ticker / 가짜 yfinance Ticker
# ---------------------------------------------------------------------------

class _AttrFastInfo:
    """속성 스타일 fast_info (dict 접근 불가) / Attribute-style fast_info (no mapping access)."""

    def __init__(self, values):
        for key, value in values.items():
            setattr(self, key, value)


def _history_frame(closes, volumes=None):
    """1년 history DataFrame 빌더 / 1-year history DataFrame builder."""
    n = len(closes)
    index = pd.date_range("2026-01-01", periods=n, freq="D")
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


def _patch_ticker(
    monkeypatch,
    fast_info=None,
    info=None,
    frame=None,
    fast_info_error=None,
    info_error=None,
    history_error=None,
):
    """yf.Ticker를 고정 응답으로 대체하고 호출 인자를 기록 / Replace yf.Ticker with fixed payloads, recording calls."""
    calls = []
    fast_info = FAST_INFO if fast_info is None else fast_info
    info = INFO if info is None else info
    frame = _history_frame([100.0, 110.0]) if frame is None else frame

    class FakeTicker:
        def __init__(self, symbol):
            self.symbol = symbol
            calls.append({"ticker": symbol})

        @property
        def fast_info(self):
            if fast_info_error is not None:
                raise fast_info_error
            return fast_info

        @property
        def info(self):
            if info_error is not None:
                raise info_error
            return info

        def history(self, period=None, **kwargs):
            calls.append({"history": period})
            if history_error is not None:
                raise history_error
            return frame

    monkeypatch.setattr(fundamentals.yf, "Ticker", FakeTicker)
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
# fast_info 매핑 / fast_info mapping
# ---------------------------------------------------------------------------

def test_fetch_detail_maps_fast_info_fields(monkeypatch):
    """가격/거래량/시가총액은 fast_info에서 / Price, volume and market cap come from fast_info."""
    _patch_ticker(monkeypatch)
    out = fundamentals.fetch_detail("AAPL")

    assert out.symbol == "AAPL"
    assert out.price == pytest.approx(110.0)
    assert out.prev_close == pytest.approx(100.0)
    assert out.open_price == pytest.approx(101.0)
    assert out.high == pytest.approx(115.0)
    assert out.low == pytest.approx(99.0)
    assert out.volume == 5000
    assert out.market_cap == pytest.approx(3.0e12)


def test_fetch_detail_change_from_prev_close(monkeypatch):
    """등락은 전일종가 기준, day_change도 동일 값 / Change is prev-close based; day_change mirrors it."""
    _patch_ticker(monkeypatch)
    out = fundamentals.fetch_detail("AAPL")

    assert out.change == pytest.approx(10.0)
    assert out.change_pct == pytest.approx(10.0)
    assert out.day_change == pytest.approx(out.change)
    assert out.day_change_pct == pytest.approx(out.change_pct)


def test_fetch_detail_zero_prev_close_keeps_pct_zero(monkeypatch):
    """전일종가를 어디서도 못 얻으면 등락률 0 (0으로 나누지 않음) / No prev close anywhere yields 0 pct (no division by zero)."""
    # fast_info previous_close = 0 + history 1봉(직전 종가 없음) / zero previous_close and a single history bar
    _patch_ticker(
        monkeypatch,
        fast_info=dict(FAST_INFO, previous_close=0.0),
        frame=_history_frame([110.0]),
    )

    out = fundamentals.fetch_detail("AAPL")
    assert out.price == pytest.approx(110.0)
    assert out.change == 0.0 and out.change_pct == 0.0


def test_fetch_detail_accepts_attribute_style_fast_info(monkeypatch):
    """fast_info가 속성 접근만 지원해도 동작 / Attribute-only fast_info still works."""
    _patch_ticker(monkeypatch, fast_info=_AttrFastInfo(FAST_INFO))
    out = fundamentals.fetch_detail("AAPL")
    assert out.price == pytest.approx(110.0) and out.market_cap == pytest.approx(3.0e12)


# ---------------------------------------------------------------------------
# info 비율 지표 / info-derived ratios
# ---------------------------------------------------------------------------

def test_fetch_detail_ratios_from_info(monkeypatch):
    """PER/EPS/베타/PBR/배당수익률은 info에서 / PE, EPS, beta, PBR and dividend yield come from info."""
    _patch_ticker(monkeypatch)
    out = fundamentals.fetch_detail("AAPL")

    assert out.pe_ratio == pytest.approx(30.5)
    assert out.eps == pytest.approx(6.1)
    assert out.beta == pytest.approx(1.2)
    assert out.pbr == pytest.approx(45.0)
    # 변환 없이 그대로 통과한다 (퍼센트 스케일) / carried through unconverted (percent scale)
    assert out.dividend_yield == pytest.approx(0.35)


def test_fetch_detail_warns_when_dividend_yield_leaves_the_percent_scale(monkeypatch, caplog):
    """
    비상식적으로 큰 배당수익률은 경고로 드러낸다 (스케일 변화 감지) / An absurd dividend yield is logged (scale-change detector).

    yfinance가 퍼센트에서 원시 분수로(또는 그 반대로) 바뀌면 화면 숫자만 조용히 100배 틀어진다.
    임계값을 넘으면 경고를 남기되 값은 그대로 통과시킨다 (데이터 오류로 페이지를 죽이지 않는다).
    If yfinance flipped between percent and raw fraction, only the rendered number would be silently off
    by 100x. Crossing the threshold logs a warning while the value still passes through, so a data glitch
    never takes the page down.
    """
    _patch_ticker(monkeypatch, info={**INFO, "dividendYield": 45.0})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = fundamentals.fetch_detail("AAPL")

    assert out.dividend_yield == pytest.approx(45.0)   # 하드 실패 금지 / never a hard failure
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "detail_dividend_yield_out_of_range"
               and p.get("symbol") == "AAPL" and p.get("dividend_yield") == 45.0
               for p in payloads), payloads


def test_fetch_detail_does_not_warn_for_a_plausible_dividend_yield(monkeypatch, caplog):
    """정상 범위의 배당수익률은 경고하지 않는다 / A plausible dividend yield stays silent."""
    _patch_ticker(monkeypatch, info={**INFO, "dividendYield": fundamentals.DIVIDEND_YIELD_SANITY_MAX})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        fundamentals.fetch_detail("AAPL")

    assert not [p for p in _warning_payloads(caplog)
                if p.get("event") == "detail_dividend_yield_out_of_range"]


def test_fetch_detail_missing_pe_is_none_not_zero(monkeypatch):
    """결측 PER은 None (0.0으로 대체하지 않음) / A missing PE is None, never 0.0."""
    _patch_ticker(monkeypatch, info={"trailingEps": 6.1})
    out = fundamentals.fetch_detail("AAPL")

    assert out.pe_ratio is None
    assert out.beta is None
    assert out.pbr is None
    assert out.dividend_yield is None
    assert out.eps == pytest.approx(6.1)


def test_fetch_detail_nan_ratio_is_none(monkeypatch):
    """NaN 비율도 None / A NaN ratio is None as well."""
    _patch_ticker(monkeypatch, info={"trailingPE": float("nan"), "beta": "n/a"})
    out = fundamentals.fetch_detail("AAPL")
    assert out.pe_ratio is None and out.beta is None


def test_fetch_detail_info_failure_warns_and_keeps_ratios_none(monkeypatch, caplog):
    """info 조회 실패는 경고 + 비율 None, 가격 데이터는 유지 / info failure warns, ratios None, price survives."""
    _patch_ticker(monkeypatch, info_error=RuntimeError("info boom"))

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = fundamentals.fetch_detail("AAPL")

    assert out.price == pytest.approx(110.0)
    assert (out.pe_ratio, out.eps, out.beta, out.pbr, out.dividend_yield) == (None,) * 5
    payloads = _warning_payloads(caplog)
    assert any("info boom" in p.get("error", "") for p in payloads)


# ---------------------------------------------------------------------------
# history: 52주 고저 / 평균 거래량 / 기간 수익률
# history: 52w range, average volume, period returns
# ---------------------------------------------------------------------------

def test_fetch_detail_history_uses_one_year_period(monkeypatch):
    """history는 period="1y"로 1회 호출 / history is called once with period="1y"."""
    calls = _patch_ticker(monkeypatch)
    fundamentals.fetch_detail("AAPL")
    assert [c for c in calls if "history" in c] == [{"history": "1y"}]


def test_fetch_detail_52w_range_and_avg_volume_from_history(monkeypatch):
    """52주 고저는 history High/Low, 평균 거래량은 최근 10봉 평균 / 52w range from High/Low, avg volume from last 10 bars."""
    closes = [100.0 + i for i in range(30)]
    volumes = [1000.0 + i for i in range(30)]
    _patch_ticker(monkeypatch, frame=_history_frame(closes, volumes=volumes))

    out = fundamentals.fetch_detail("AAPL")
    assert out.week52_high == pytest.approx(130.0)   # max(close+1)
    assert out.week52_low == pytest.approx(99.0)     # min(close-1)
    assert out.avg_volume == int(sum(volumes[-10:]) / 10)


def test_fetch_detail_52w_falls_back_to_fast_info_when_history_empty(monkeypatch, caplog):
    """history가 비면 fast_info year_high/low로 폴백 + 경고 / Empty history falls back to fast_info year high/low with a warning."""
    _patch_ticker(monkeypatch, frame=_history_frame([]))

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = fundamentals.fetch_detail("AAPL")

    assert out.week52_high == pytest.approx(130.0)
    assert out.week52_low == pytest.approx(80.0)
    assert out.returns == {"1w": None, "1m": None, "3m": None, "1y": None}
    assert out.avg_volume == 0
    assert any(p.get("symbol") == "AAPL" for p in _warning_payloads(caplog))


def test_fetch_detail_history_failure_warns_and_keeps_price(monkeypatch, caplog):
    """history 실패도 가격 응답은 유지 / A history failure still returns the price payload."""
    _patch_ticker(monkeypatch, history_error=RuntimeError("hist boom"))

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = fundamentals.fetch_detail("AAPL")

    assert out.price == pytest.approx(110.0)
    assert out.returns == {"1w": None, "1m": None, "3m": None, "1y": None}
    assert any("hist boom" in p.get("error", "") for p in _warning_payloads(caplog))


def test_fetch_detail_period_returns(monkeypatch):
    """기간수익률: 마지막 종가 vs N봉 전 종가 (5/21/63/250) / Period returns: last close vs the close N bars back."""
    closes = [100.0 + i for i in range(260)]   # 100..359
    _patch_ticker(monkeypatch, frame=_history_frame(closes))

    returns = fundamentals.fetch_detail("AAPL").returns
    last = closes[-1]
    assert set(returns) == {"1w", "1m", "3m", "1y"}
    assert returns["1w"] == pytest.approx((last - closes[-6]) / closes[-6] * 100)
    assert returns["1m"] == pytest.approx((last - closes[-22]) / closes[-22] * 100)
    assert returns["3m"] == pytest.approx((last - closes[-64]) / closes[-64] * 100)
    assert returns["1y"] == pytest.approx((last - closes[-251]) / closes[-251] * 100)
    assert fundamentals.RETURN_ROWS == {"1w": 5, "1m": 21, "3m": 63, "1y": 250}


def test_fetch_detail_period_returns_clamped_to_available_history(monkeypatch):
    """history가 짧으면 가장 오래된 종가로 클램프 / Short history clamps to the oldest available close."""
    closes = [100.0 + i for i in range(10)]   # 100..109 -> 9 bars back at most
    _patch_ticker(monkeypatch, frame=_history_frame(closes))

    returns = fundamentals.fetch_detail("AAPL").returns
    oldest_pct = (closes[-1] - closes[0]) / closes[0] * 100
    assert returns["1w"] == pytest.approx((closes[-1] - closes[-6]) / closes[-6] * 100)
    assert returns["1m"] == pytest.approx(oldest_pct)
    assert returns["3m"] == pytest.approx(oldest_pct)
    assert returns["1y"] == pytest.approx(oldest_pct)


def test_fetch_detail_period_returns_none_with_single_bar(monkeypatch):
    """봉이 1개면 비교 대상이 없어 전부 None / A single bar leaves nothing to compare against."""
    _patch_ticker(monkeypatch, frame=_history_frame([123.0]))
    assert fundamentals.fetch_detail("AAPL").returns == {
        "1w": None, "1m": None, "3m": None, "1y": None,
    }


def test_fetch_detail_skips_nan_closes_in_history(monkeypatch):
    """NaN 종가 행은 수익률 계산에서 제외 / NaN close rows are dropped before computing returns."""
    closes = [100.0, float("nan"), 110.0]
    _patch_ticker(monkeypatch, frame=_history_frame(closes))

    returns = fundamentals.fetch_detail("AAPL").returns
    assert returns["1w"] == pytest.approx(10.0)   # 110 vs 100


# ---------------------------------------------------------------------------
# 시장/통화/이름 / market, currency, name
# ---------------------------------------------------------------------------

def test_fetch_detail_us_symbol_market_and_config_labels(monkeypatch):
    """US 심볼은 USD/us + config 이름/섹터 / US symbols get USD/us plus config name and sector."""
    _patch_ticker(monkeypatch)
    out = fundamentals.fetch_detail("AAPL")

    assert out.market == "us"
    assert out.currency == "USD"
    assert out.name == config.STOCK_NAMES["AAPL"]
    assert out.sector == config.STOCK_SECTORS["AAPL"]


@pytest.mark.parametrize("symbol", ["005930.KS", "247540.KQ"])
def test_fetch_detail_kr_symbol_market_and_currency(monkeypatch, symbol):
    """.KS/.KQ 심볼은 KRW/kr / .KS and .KQ symbols get KRW/kr."""
    _patch_ticker(monkeypatch)
    out = fundamentals.fetch_detail(symbol)

    assert out.market == "kr"
    assert out.currency == "KRW"
    assert out.name == config.STOCK_NAMES[symbol]
    assert out.sector == config.STOCK_SECTORS[symbol]


def test_fetch_detail_unknown_symbol_falls_back_to_symbol_and_blank_sector(monkeypatch):
    """유니버스 밖 심볼은 이름=심볼, 섹터="" / Unknown symbols fall back to symbol / blank sector."""
    _patch_ticker(monkeypatch)
    out = fundamentals.fetch_detail("ZZZZ")
    assert out.name == "ZZZZ" and out.sector == ""


def test_fetch_detail_sets_utc_last_updated(monkeypatch):
    """last_updated는 UTC aware / last_updated is timezone-aware UTC."""
    _patch_ticker(monkeypatch)
    out = fundamentals.fetch_detail("AAPL")
    assert out.last_updated is not None
    assert out.last_updated.tzinfo is not None
    assert out.last_updated.utcoffset() == timezone.utc.utcoffset(None)


# ---------------------------------------------------------------------------
# 실패 경로 / failure paths
# ---------------------------------------------------------------------------

def test_fetch_detail_price_falls_back_to_history_close(monkeypatch, caplog):
    """fast_info 실패 시 history 종가로 가격 복구 / A fast_info failure recovers price from history closes."""
    _patch_ticker(
        monkeypatch,
        fast_info_error=RuntimeError("fast boom"),
        frame=_history_frame([100.0, 110.0]),
    )

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = fundamentals.fetch_detail("AAPL")

    assert out.price == pytest.approx(110.0)
    assert out.prev_close == pytest.approx(100.0)
    assert out.change_pct == pytest.approx(10.0)
    assert any("fast boom" in p.get("error", "") for p in _warning_payloads(caplog))


def test_fetch_detail_without_any_price_warns_and_raises(monkeypatch, caplog):
    """가격을 어디서도 얻지 못하면 경고 + 예외 (조용한 실패 금지) / No price anywhere warns and raises."""
    _patch_ticker(monkeypatch, fast_info={}, frame=_history_frame([]))

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        with pytest.raises(RuntimeError):
            fundamentals.fetch_detail("AAPL")

    assert any(p.get("symbol") == "AAPL" for p in _warning_payloads(caplog))
