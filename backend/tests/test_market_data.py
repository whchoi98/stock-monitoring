"""
시장 데이터 서비스 테스트 - yfinance는 monkeypatch로 대체하여 실제 네트워크 호출 없음
Market data service tests - yfinance is monkeypatched, so no real network calls happen.
"""
import json
import logging

import pandas as pd
import pytest

from app.core import config
from app.services import market_data

LOGGER_NAME = "app.services.market_data"


# ---------------------------------------------------------------------------
# Fake yfinance frames / 가짜 yfinance 프레임
# ---------------------------------------------------------------------------

def fake_download(symbols, **kw):
    """멀티 티커 MultiIndex 프레임 (yfinance group_by="ticker" 형태) / Multi-ticker MultiIndex frame."""
    idx = pd.to_datetime(["2026-07-30", "2026-07-31"])
    if isinstance(symbols, str):
        symbols = [symbols]
    cols = pd.MultiIndex.from_product([symbols, ["Close", "Volume"]])
    df = pd.DataFrame(index=idx, columns=cols, dtype=float)
    for s in symbols:
        df[(s, "Close")] = [100.0, 110.0]
        df[(s, "Volume")] = [1000, 2000]
    return df


def _multi_frame(symbols, closes=None, volumes=None):
    """심볼별 종가/거래량을 지정할 수 있는 MultiIndex 프레임 빌더 / MultiIndex frame builder with overrides."""
    idx = pd.to_datetime(["2026-07-30", "2026-07-31"])
    closes = closes or {}
    volumes = volumes or {}
    cols = pd.MultiIndex.from_product([symbols, ["Close", "Volume"]])
    df = pd.DataFrame(index=idx, columns=cols, dtype=float)
    for s in symbols:
        df[(s, "Close")] = closes.get(s, [100.0, 110.0])
        df[(s, "Volume")] = volumes.get(s, [1000.0, 2000.0])
    return df


def _flat_frame(closes=(100.0, 110.0), volumes=(1000.0, 2000.0)):
    """단일 티커 평면 프레임 (컬럼 레벨 1개) / Single-ticker flat frame (single column level)."""
    idx = pd.to_datetime(["2026-07-30", "2026-07-31"])
    return pd.DataFrame({"Close": list(closes), "Volume": list(volumes)}, index=idx)


def _warning_payloads(caplog):
    """경고 로그가 모두 단일 라인 JSON임을 확인하고 파싱 / Assert single-line JSON warnings and parse them."""
    payloads = []
    for record in caplog.records:
        message = record.getMessage()
        assert "\n" not in message  # 단일 라인 JSON / single-line JSON
        payloads.append(json.loads(message))
    return payloads


# ---------------------------------------------------------------------------
# Brief Step 1 tests / 브리프 Step 1 테스트
# ---------------------------------------------------------------------------

def test_fetch_indices_change(monkeypatch):
    monkeypatch.setattr(market_data.yf, "download", fake_download)
    out = market_data.fetch_indices()
    kospi = next(i for i in out if i.symbol == "^KS11")
    assert kospi.value == 110.0 and round(kospi.change_pct, 1) == 10.0


def test_fetch_quotes_kr_currency(monkeypatch):
    monkeypatch.setattr(market_data.yf, "download", fake_download)
    out = market_data.fetch_quotes("kr")
    assert len(out) == 50 and out[0].currency == "KRW" and out[0].symbol.endswith((".KS", ".KQ"))


# ---------------------------------------------------------------------------
# fetch_indices
# ---------------------------------------------------------------------------

def test_fetch_indices_covers_us_and_kr_in_one_batch(monkeypatch):
    """US+KR 지수를 한 번의 download로 조회하고 config 이름을 사용 / One batch download, names from config."""
    calls = []

    def recording_download(symbols, **kw):
        calls.append((list(symbols), kw))
        return fake_download(symbols, **kw)

    monkeypatch.setattr(market_data.yf, "download", recording_download)
    out = market_data.fetch_indices()

    assert len(calls) == 1
    requested, kwargs = calls[0]
    assert requested == list(config.US_INDICES) + list(config.KR_INDICES)
    assert kwargs["period"] == "5d"
    assert kwargs["group_by"] == "ticker"
    assert kwargs["threads"] is False
    assert kwargs["progress"] is False

    assert [i.symbol for i in out] == requested
    names = {i.symbol: i.name for i in out}
    assert names["^GSPC"] == config.US_INDICES["^GSPC"]
    assert names["^KQ11"] == config.KR_INDICES["^KQ11"]
    assert all(i.change == pytest.approx(10.0) for i in out)


def test_fetch_indices_skips_missing_symbol_and_warns(monkeypatch, caplog):
    """프레임에 없는 지수는 skip + 경고 (조용한 실패 금지) / Missing index column is skipped with a warning."""
    present = [s for s in {**config.US_INDICES, **config.KR_INDICES} if s != "^DJI"]

    monkeypatch.setattr(market_data.yf, "download", lambda symbols, **kw: fake_download(present))
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = market_data.fetch_indices()

    assert [i.symbol for i in out] == present
    payloads = _warning_payloads(caplog)
    assert any(p.get("symbol") == "^DJI" for p in payloads)


def test_fetch_indices_download_failure_returns_empty_and_warns(monkeypatch, caplog):
    """다운로드 자체가 실패하면 빈 리스트 + 경고 / Whole-batch failure yields empty list plus warning."""
    def boom(symbols, **kw):
        raise RuntimeError("network down")

    monkeypatch.setattr(market_data.yf, "download", boom)
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert market_data.fetch_indices() == []

    payloads = _warning_payloads(caplog)
    assert any("network down" in p.get("error", "") for p in payloads)


# ---------------------------------------------------------------------------
# fetch_indicators
# ---------------------------------------------------------------------------

def test_fetch_indicators_values_and_units(monkeypatch):
    """모든 지표를 config 이름/단위와 함께 반환 / Returns every indicator with config name and unit."""
    calls = []

    def recording_download(symbols, **kw):
        calls.append((list(symbols), kw))
        return fake_download(symbols, **kw)

    monkeypatch.setattr(market_data.yf, "download", recording_download)
    out = market_data.fetch_indicators()

    assert len(calls) == 1
    assert calls[0][0] == list(config.INDICATORS)
    assert calls[0][1]["period"] == "5d"

    assert len(out) == len(config.INDICATORS)
    by_symbol = {i.symbol: i for i in out}
    krw = by_symbol["KRW=X"]
    assert krw.name == "USD/KRW" and krw.unit == "W"
    assert krw.value == 110.0 and krw.change == pytest.approx(10.0)
    assert round(krw.change_pct, 1) == 10.0
    assert by_symbol["^TNX"].unit == "%"


def test_fetch_indicators_dropna_uses_last_valid_closes(monkeypatch):
    """NaN 행은 dropna로 제거하고 남은 마지막 2개 종가로 계산 / dropna then last two valid closes."""
    symbols = list(config.INDICATORS)
    closes = {
        "GC=F": [100.0, float("nan")],          # 마지막 행 NaN / trailing NaN row
        "CL=F": [float("nan"), float("nan")],   # 전부 NaN → skip / all NaN -> skipped
    }
    monkeypatch.setattr(
        market_data.yf, "download", lambda s, **kw: _multi_frame(symbols, closes=closes)
    )
    out = market_data.fetch_indicators()

    by_symbol = {i.symbol: i for i in out}
    assert "CL=F" not in by_symbol
    gold = by_symbol["GC=F"]
    assert gold.value == 100.0 and gold.change == 0.0 and gold.change_pct == 0.0


# ---------------------------------------------------------------------------
# fetch_quotes
# ---------------------------------------------------------------------------

def test_fetch_quotes_us_fields_from_config(monkeypatch):
    """US 시세: name/sector는 config, currency USD, market_cap은 None / US quote field mapping."""
    monkeypatch.setattr(market_data.yf, "download", fake_download)
    out = market_data.fetch_quotes("us")

    assert len(out) == len(config.US_STOCKS)
    aapl = next(q for q in out if q.symbol == "AAPL")
    assert aapl.name == config.US_STOCK_NAMES["AAPL"]
    assert aapl.sector == config.US_STOCK_SECTORS["AAPL"]
    assert aapl.price == 110.0
    assert aapl.change == pytest.approx(10.0)
    assert round(aapl.change_pct, 1) == 10.0
    assert aapl.volume == 2000
    assert aapl.market == "us"
    assert aapl.currency == "USD"
    assert aapl.market_cap is None


def test_fetch_quotes_kr_names_sectors_from_config(monkeypatch):
    """KR 시세도 동일한 yfinance 경로 + config 매핑 / KR quotes use the same yfinance path and config maps."""
    monkeypatch.setattr(market_data.yf, "download", fake_download)
    out = market_data.fetch_quotes("kr")

    samsung = next(q for q in out if q.symbol == "005930.KS")
    assert samsung.name == config.KR_STOCK_NAMES["005930.KS"]
    assert samsung.sector == config.KR_STOCK_SECTORS["005930.KS"]
    assert samsung.market == "kr"
    assert samsung.currency == "KRW"
    kosdaq = next(q for q in out if q.symbol.endswith(".KQ"))
    assert kosdaq.currency == "KRW"


def test_fetch_quotes_downloads_the_whole_market_in_one_batch(monkeypatch):
    """
    시장 전체를 한 번의 download로 조회한다 / The whole market goes out as one download call.

    2026-08-04 라이브 장애: Yahoo가 병렬 청크 버스트(10개×5워커)를 심볼 전부 빈 프레임으로
    돌려주기 시작했다 — 같은 시점에 50심볼 단일 배치는 50/50 성공(실측 2회). 그래서 1차 경로는
    단일 배치이고 청크는 직렬 폴백으로만 남는다.
    Live incident 2026-08-04: Yahoo started answering the parallel chunk burst (10×5 workers) with
    all-empty frames while a single 50-symbol batch succeeded 50/50 (measured twice). The primary
    path is therefore one batch; chunks survive only as a serial fallback.
    """
    calls = []

    def recording_download(symbols, **kw):
        calls.append((list(symbols), kw))
        return fake_download(symbols, **kw)

    monkeypatch.setattr(market_data.yf, "download", recording_download)
    out = market_data.fetch_quotes("us")

    assert len(calls) == 1
    requested, kwargs = calls[0]
    assert requested == list(config.US_STOCKS)
    assert kwargs["period"] == "7d" and kwargs["threads"] is False
    assert [q.symbol for q in out] == config.US_STOCKS  # 요청 순서 유지 / request order preserved


def test_fetch_quotes_falls_back_to_serial_chunks_when_the_batch_fails(monkeypatch, caplog):
    """단일 배치가 죽으면 직렬 청크로 폴백한다 / A dead batch falls back to serial chunks."""
    calls = []

    def flaky_download(symbols, **kw):
        calls.append(list(symbols))
        if len(calls) == 1:
            raise RuntimeError("boom")  # 전체 배치 실패 / the whole batch dies
        return fake_download(symbols, **kw)

    sleeps = []
    monkeypatch.setattr(market_data.yf, "download", flaky_download)
    monkeypatch.setattr(market_data.time, "sleep", lambda s: sleeps.append(s))
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = market_data.fetch_quotes("us")

    assert [q.symbol for q in out] == config.US_STOCKS
    assert calls[0] == list(config.US_STOCKS)               # 1차: 전체 배치 / first: the whole batch
    chunk_calls = calls[1:]
    assert all(len(c) <= market_data.QUOTE_CHUNK_SIZE for c in chunk_calls)
    # 직렬 + 순서 보존 (병렬이면 순서가 흔들린다) / serial and order-preserving (parallelism would shuffle)
    assert [s for c in chunk_calls for s in c] == list(config.US_STOCKS)
    # 청크 사이 지연 — 빈도 기반 스로틀을 자극하지 않는다 / inter-chunk delay to avoid poking the frequency throttle
    assert sleeps == [market_data.QUOTE_CHUNK_DELAY] * (len(chunk_calls) - 1)
    assert any(p.get("event") == "quote_batch_failed" for p in _warning_payloads(caplog))


def test_fetch_quotes_raises_when_no_symbol_yields_a_price(monkeypatch, caplog):
    """
    전 심볼 빈 결과는 성공이 아니라 실패다 / An all-empty result is a failure, not a success.

    빈 리스트가 캐시에 "성공"으로 저장되면 마지막 정상 데이터를 밀어내고 stale-while-error가
    무력화된다 (2026-08-04 라이브 장애의 2차 원인 — US 목록이 빈 화면이 됐다). 예외로 승격하면
    `deps.cached`의 stale 폴백이 마지막 정상 시세를 계속 서빙한다.
    An empty list cached as "success" evicts the last good data and disarms stale-while-error (the
    incident's second cause — the US table went blank). Raising instead lets `deps.cached`'s stale
    fallback keep serving the last good quotes.
    """
    def empty_download(symbols, **kw):
        if isinstance(symbols, str):
            symbols = [symbols]
        idx = pd.to_datetime(["2026-07-30", "2026-07-31"])
        cols = pd.MultiIndex.from_product([symbols, ["Close", "Volume"]])
        return pd.DataFrame(index=idx, columns=cols, dtype=float)  # 전부 NaN / all NaN

    monkeypatch.setattr(market_data.yf, "download", empty_download)
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        with pytest.raises(market_data.QuotesUnavailableError):
            market_data.fetch_quotes("us")

    assert any(p.get("event") == "quotes_empty" for p in _warning_payloads(caplog))


def test_fetch_quotes_single_symbol_flat_frame(monkeypatch):
    """단일 심볼 평면 프레임(컬럼 레벨 1개)도 파싱 / Single-ticker flat frame is parsed too."""
    monkeypatch.setattr(config, "US_STOCKS", ["AAPL"])
    monkeypatch.setattr(market_data.yf, "download", lambda symbols, **kw: _flat_frame())

    out = market_data.fetch_quotes("us")
    assert len(out) == 1
    assert out[0].symbol == "AAPL" and out[0].price == 110.0 and out[0].volume == 2000


def test_fetch_quotes_single_symbol_multiindex_frame(monkeypatch):
    """단일 심볼이라도 yfinance가 MultiIndex를 주면 그대로 파싱 / Single-ticker MultiIndex frame is parsed."""
    monkeypatch.setattr(config, "US_STOCKS", ["MSFT"])
    monkeypatch.setattr(market_data.yf, "download", fake_download)

    out = market_data.fetch_quotes("us")
    assert len(out) == 1 and out[0].symbol == "MSFT" and out[0].price == 110.0


def test_fetch_quotes_skips_nan_price_rows(monkeypatch, caplog):
    """최신 종가가 NaN인 종목은 skip, 나머지는 정상 반환 / NaN latest close is skipped, rest survive."""
    closes = {"AAPL": [100.0, float("nan")], "MSFT": [float("nan"), float("nan")]}

    def download(symbols, **kw):
        return _multi_frame(list(symbols), closes=closes)

    monkeypatch.setattr(market_data.yf, "download", download)
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = market_data.fetch_quotes("us")

    symbols = {q.symbol for q in out}
    assert "AAPL" not in symbols and "MSFT" not in symbols
    assert len(out) == len(config.US_STOCKS) - 2
    warned = {p.get("symbol") for p in _warning_payloads(caplog)}
    assert {"AAPL", "MSFT"} <= warned


def test_fetch_quotes_chunk_failure_does_not_kill_batch(monkeypatch, caplog):
    """청크 하나가 예외를 던져도 나머지 청크는 반환 / One failing chunk must not kill the batch."""
    first_chunk = set(config.US_STOCKS[:10])

    def flaky_download(symbols, **kw):
        if first_chunk & set(symbols):
            raise RuntimeError("chunk boom")
        return fake_download(symbols, **kw)

    monkeypatch.setattr(market_data.yf, "download", flaky_download)
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = market_data.fetch_quotes("us")

    assert len(out) == len(config.US_STOCKS) - 10
    assert not (first_chunk & {q.symbol for q in out})
    payloads = _warning_payloads(caplog)
    assert any("chunk boom" in p.get("error", "") for p in payloads)


def test_fetch_quotes_rejects_unknown_market(monkeypatch):
    """지원하지 않는 market 인자는 ValueError / Unsupported market argument raises ValueError."""
    monkeypatch.setattr(market_data.yf, "download", fake_download)
    with pytest.raises(ValueError):
        market_data.fetch_quotes("jp")


# ---------------------------------------------------------------------------
# fetch_market_caps
# ---------------------------------------------------------------------------

class _MappingFastInfo:
    """dict 스타일 fast_info / dict-style fast_info."""

    def __init__(self, cap):
        self._cap = cap

    def __getitem__(self, key):
        if key != "market_cap":
            raise KeyError(key)
        return self._cap


class _AttrFastInfo:
    """속성 스타일 fast_info / attribute-style fast_info."""

    def __init__(self, cap):
        self.market_cap = cap


def test_fetch_market_caps_returns_caps_and_skips_failures(monkeypatch, caplog):
    """실패 심볼은 skip + 경고, 성공 심볼만 dict에 담김 / Failures are skipped with a warning."""
    class FakeTicker:
        def __init__(self, symbol):
            self.symbol = symbol

        @property
        def fast_info(self):
            if self.symbol == "BOOM":
                raise RuntimeError("ticker boom")
            if self.symbol == "NONE":
                return _MappingFastInfo(None)
            if self.symbol == "ATTR":
                return _AttrFastInfo(3.0e12)
            return _MappingFastInfo(1.5e12)

    monkeypatch.setattr(market_data.yf, "Ticker", FakeTicker)
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        caps = market_data.fetch_market_caps(["AAPL", "ATTR", "BOOM", "NONE"])

    assert caps == {"AAPL": 1.5e12, "ATTR": 3.0e12}
    assert all(isinstance(v, float) for v in caps.values())
    payloads = _warning_payloads(caplog)
    assert any("ticker boom" in p.get("error", "") for p in payloads)


def test_fetch_market_caps_empty_input(monkeypatch):
    """빈 입력은 빈 dict, download/Ticker 호출 없음 / Empty input returns empty dict with no calls."""
    def boom(*args, **kwargs):
        raise AssertionError("must not be called")

    monkeypatch.setattr(market_data.yf, "Ticker", boom)
    assert market_data.fetch_market_caps([]) == {}
