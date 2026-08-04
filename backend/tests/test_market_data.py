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
# 픽스처 / Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def sleeps(monkeypatch) -> list:
    """
    재시도 백오프를 가로챈다 (어떤 테스트도 실제 초를 태우지 않는다).
    Intercept the retry backoff so no test burns real seconds.

    autouse: `fetch_quotes`는 심볼이 빠지면 항상 백오프 후 재시도하므로, 패치를 잊은 테스트가
    스위트에 수 초를 더한다. 지연을 검증하는 테스트는 이 픽스처를 인자로 받아 기록을 읽는다.
    autouse because `fetch_quotes` always backs off before its retry whenever a symbol is missing, so
    an unpatched test silently adds seconds to the suite. Tests that assert on the delay take this
    fixture as an argument and read the recorded values.
    """
    recorded: list = []
    monkeypatch.setattr(market_data.time, "sleep", lambda seconds: recorded.append(seconds))
    return recorded


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


def _partial_download(alive):
    """`alive` 심볼만 가격을 주고 나머지는 전부 NaN인 가짜 download / Fake download pricing only `alive`."""
    def download(symbols, **kw):
        symbols = [symbols] if isinstance(symbols, str) else list(symbols)
        closes = {s: [float("nan"), float("nan")] for s in symbols if s not in alive}
        return _multi_frame(symbols, closes=closes)

    return download


def _empty_frame(symbols):
    """전 심볼이 NaN인 프레임 (2026-08-04 장애의 실제 모양) / All-NaN frame, the incident's actual shape."""
    symbols = [symbols] if isinstance(symbols, str) else list(symbols)
    idx = pd.to_datetime(["2026-07-30", "2026-07-31"])
    cols = pd.MultiIndex.from_product([symbols, ["Close", "Volume"]])
    return pd.DataFrame(index=idx, columns=cols, dtype=float)


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
    # yfinance 기본값(10s)에 기대지 않고 명시한다 / explicit, never yfinance's 10s default
    assert kwargs["timeout"] == market_data.DOWNLOAD_TIMEOUT

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


def test_fetch_quotes_requests_every_symbol_serially_with_an_explicit_timeout(monkeypatch):
    """
    심볼당 요청 1건을 순차로 보내고, 요청마다 명시적 타임아웃을 준다.
    One serial request per symbol, each carrying an explicit timeout.

    `yf.download(..., threads=False)`는 배치를 받아도 내부적으로 심볼당 순차 HTTP 요청을 보낸다
    (yfinance/multi.py의 `_download_one` 루프) — "50심볼 배치 = 호출 1회"는 사실이 아니다.
    Yahoo가 스로틀한 것은 배치 크기가 아니라 동시성이었으므로 심볼별로 직접 요청해도 업스트림이
    보는 트래픽은 같고, 그 대신 요청 사이에서 데드라인을 확인할 수 있다.
    `yf.download(..., threads=False)` issues one sequential HTTP request per symbol even for a batch
    (the `_download_one` loop in yfinance/multi.py): "a 50-symbol batch is one call" is false. What
    Yahoo throttled was concurrency, not batch size, so issuing the requests ourselves shows upstream
    the exact same traffic while letting us check the deadline between them.
    """
    calls = []

    def recording_download(symbols, **kw):
        calls.append((list(symbols), kw))
        return fake_download(symbols, **kw)

    monkeypatch.setattr(market_data.yf, "download", recording_download)
    out = market_data.fetch_quotes("us")

    # 심볼당 1건, config 순서 그대로 / one request per symbol, in config order
    assert [symbols for symbols, _kwargs in calls] == [[s] for s in config.US_STOCKS]
    for _symbols, kwargs in calls:
        assert kwargs["period"] == "7d"
        assert kwargs["threads"] is False
        assert kwargs["timeout"] == market_data.DOWNLOAD_TIMEOUT
    assert [q.symbol for q in out] == config.US_STOCKS  # 요청 순서 유지 / request order preserved


def test_fetch_quotes_retries_only_the_missing_symbols(monkeypatch, caplog, sleeps):
    """
    재시도는 빠진 심볼만 다시 요청한다 (전체 재실행 금지) / The retry re-requests only the missing symbols.

    전체를 다시 돌리면 이미 받은 심볼까지 두 번 때려 스로틀을 자극한다. 재시도 앞에는 고정 지연
    열차가 아니라 지터 백오프 1회만 넣는다.
    Re-running everything would hit the already-parsed symbols twice and poke the throttle. The retry
    is preceded by a single jittered backoff, not a train of fixed delays.
    """
    missing = list(config.US_STOCKS[:3])
    primary_calls = len(config.US_STOCKS)
    calls = []

    def flaky_download(symbols, **kw):
        symbols = list(symbols)
        calls.append(symbols)
        # 1차 패스에서만 실패하고 재시도에서는 성공 / fails in the primary pass, succeeds on retry
        if len(calls) <= primary_calls and set(symbols) & set(missing):
            raise RuntimeError("symbol boom")
        return fake_download(symbols, **kw)

    monkeypatch.setattr(market_data.yf, "download", flaky_download)
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = market_data.fetch_quotes("us")

    assert [q.symbol for q in out] == config.US_STOCKS  # 재시도로 전량 복구 / the retry restores the full set
    assert calls[:primary_calls] == [[s] for s in config.US_STOCKS]
    assert calls[primary_calls:] == [[s] for s in missing]  # 빠진 심볼만 / only the missing ones
    low, high = market_data.QUOTE_RETRY_BACKOFF
    assert len(sleeps) == 1 and low <= sleeps[0] <= high
    assert any(p.get("event") == "quote_download_failed" for p in _warning_payloads(caplog))


def test_fetch_quotes_retries_and_raises_when_the_primary_pass_is_all_empty(monkeypatch, caplog, sleeps):
    """
    예외 없이 "전부 빈 프레임"으로 온 1차 패스도 재시도 대상이고, 그래도 비면 예외다.
    An all-empty primary pass (no exception thrown) is retried too, and still raises when empty.

    2026-08-04 장애의 실제 모양이 이것이었다: 예외가 아니라 빈 프레임이었고, 그래서 빈 리스트가
    "성공"으로 캐시에 저장돼 마지막 정상 시세를 밀어냈다.
    This was the incident's actual shape: not an exception but empty frames, which is how the empty
    list got cached as "success" and evicted the last good quotes.
    """
    calls = []

    def empty_download(symbols, **kw):
        calls.append(list(symbols))
        return _empty_frame(symbols)

    monkeypatch.setattr(market_data.yf, "download", empty_download)
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        with pytest.raises(market_data.QuotesUnavailableError):
            market_data.fetch_quotes("us")

    # 1차 패스 + 빠진 전 심볼 재시도 / the primary pass plus a retry of every missing symbol
    assert calls == [[s] for s in config.US_STOCKS] * 2
    assert len(sleeps) == 1
    assert "quotes_empty" in {p.get("event") for p in _warning_payloads(caplog)}


def test_fetch_quotes_stops_issuing_requests_when_the_deadline_expires(monkeypatch, caplog):
    """
    총 데드라인이 만료되면 새 요청을 내지 않고 가진 것으로 판정한다.
    Once the total deadline expires, no new request is issued and what we have is evaluated.

    `fetch_quotes`는 `asyncio.to_thread`(공용 기본 executor)에서 돈다 — 느린 업스트림에 심볼 수 ×
    요청 타임아웃만큼 워커를 붙잡아두면 안 된다 (50×8s = 400s).
    `fetch_quotes` runs on `asyncio.to_thread`'s shared default executor, so a slow upstream must not
    hold a worker for symbols × per-request timeout (50 × 8s = 400s).
    """
    clock = {"t": 0.0}
    calls = []

    def slow_download(symbols, **kw):
        calls.append(list(symbols))
        # 요청 2건이면 예산을 소진한다 / two requests exhaust the budget
        clock["t"] += market_data.QUOTE_FETCH_DEADLINE / 2
        return fake_download(symbols, **kw)

    monkeypatch.setattr(market_data, "_now", lambda: clock["t"])
    monkeypatch.setattr(market_data.yf, "download", slow_download)
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        with pytest.raises(market_data.QuotesUnavailableError):
            market_data.fetch_quotes("us")

    assert len(calls) == 2  # 50심볼이 아니라 예산이 허용한 만큼만 / only what the budget allowed
    events = {p.get("event") for p in _warning_payloads(caplog)}
    assert "quote_deadline_reached" in events
    assert "quotes_coverage_too_low" in events


def test_fetch_quotes_returns_a_partial_result_at_the_coverage_floor(monkeypatch, caplog):
    """
    커버리지가 하한(60%)이면 부분 결과를 반환하고 누락 수를 경고한다.
    At the coverage floor (60%) a partial result is returned, with the missing count warned.
    """
    floor = int(len(config.US_STOCKS) * market_data.QUOTE_MIN_COVERAGE)  # 30/50 = 60%
    alive = set(config.US_STOCKS[:floor])

    monkeypatch.setattr(market_data.yf, "download", _partial_download(alive))
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = market_data.fetch_quotes("us")

    assert [q.symbol for q in out] == config.US_STOCKS[:floor]
    partial = next(p for p in _warning_payloads(caplog) if p.get("event") == "quotes_partial")
    assert partial["missing"] == len(config.US_STOCKS) - floor
    assert partial["parsed"] == floor


def test_fetch_quotes_raises_just_below_the_coverage_floor(monkeypatch, caplog):
    """
    하한 미달(29/50 = 58%)은 예외다 — 심하게 빈 결과가 마지막 정상 시세를 밀어내지 못하게 한다.
    Just below the floor (29/50 = 58%) raises, so a severely partial result cannot evict the last
    good quotes from the cache.
    """
    floor = int(len(config.US_STOCKS) * market_data.QUOTE_MIN_COVERAGE)
    alive = set(config.US_STOCKS[:floor - 1])

    monkeypatch.setattr(market_data.yf, "download", _partial_download(alive))
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        with pytest.raises(market_data.QuotesUnavailableError):
            market_data.fetch_quotes("us")

    too_low = next(p for p in _warning_payloads(caplog) if p.get("event") == "quotes_coverage_too_low")
    assert too_low["parsed"] == floor - 1
    assert too_low["requested"] == len(config.US_STOCKS)


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
    monkeypatch.setattr(market_data.yf, "download", lambda symbols, **kw: _empty_frame(symbols))
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


def test_fetch_quotes_symbol_failure_does_not_kill_the_pass(monkeypatch, caplog):
    """
    한 심볼의 요청 예외가 남은 심볼 조회를 죽이지 않는다 / One symbol's exception must not kill the pass.

    40/50 = 80% ≥ QUOTE_MIN_COVERAGE 이므로 부분 결과를 반환한다.
    40/50 = 80% is at or above QUOTE_MIN_COVERAGE, so the partial result is returned.
    """
    dead = set(config.US_STOCKS[:10])

    def flaky_download(symbols, **kw):
        if dead & set(symbols):
            raise RuntimeError("symbol boom")
        return fake_download(symbols, **kw)

    monkeypatch.setattr(market_data.yf, "download", flaky_download)
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        out = market_data.fetch_quotes("us")

    assert len(out) == len(config.US_STOCKS) - 10
    assert not (dead & {q.symbol for q in out})
    payloads = _warning_payloads(caplog)
    assert any("symbol boom" in p.get("error", "") for p in payloads)


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
