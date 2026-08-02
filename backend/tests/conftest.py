"""
API 테스트 공용 픽스처 - 서비스 전부 페이크로 교체하고 인메모리 L2로 TieredCache를 구성한다.
Shared API test fixtures - every service is replaced by a fake and L2 is an in-memory stub.

실제 네트워크(yfinance/httpx)와 AWS(boto3)는 한 번도 호출되지 않는다.
No real network (yfinance/httpx) and no AWS (boto3) call is ever made.
"""
from __future__ import annotations

import json
from collections import Counter
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

from app.cache.memory import MemoryCache
from app.cache.tiered import TieredCache
from app.core import config
from app.main import create_app
from app.models import Candle, ChartResponse, IndexQuote, Indicator, NewsItem, Quote, StockDetailResponse
from app.services import charts, fundamentals, market_data, news
from app.state import AppState

# 테스트가 쓰는 심볼 (config 유니버스 내부) / Symbols used by the tests (inside the config universe)
US_SYMBOL = "AAPL"
KR_SYMBOL = "005930.KS"
UNKNOWN_SYMBOL = "ZZZZ"

# 차트 캔들 수 - 수급 10일 테스트가 성립하도록 10개 이상 / Candle count: > 10 so the 10-day investor test holds
CHART_CANDLES = 12

FAKE_DETAIL_PRICE = 187.5


# ---------------------------------------------------------------------------
# 인메모리 L2 / In-memory L2
# ---------------------------------------------------------------------------

class FakeL2:
    """
    TieredCache의 L2 덕타이핑 프로토콜만 구현한 인메모리 스텁 / In-memory stub of the L2 duck-typed protocol.

    `put`에서 `json.dumps`를 실행해 캐시에 담기는 값이 실제 DynamoDB L2처럼
    JSON 직렬화 가능한지 검증한다 (pydantic 모델을 그대로 캐싱하면 여기서 터진다).
    `put` runs `json.dumps` so cached values are proven JSON-serializable like the real
    DynamoDB L2 (caching pydantic models raw fails right here).
    """

    def __init__(self) -> None:
        self.store: dict[str, tuple] = {}
        self.puts = 0

    async def get(self, key: str) -> Optional[tuple]:
        item = self.store.get(key)
        return None if item is None else (item[0], item[1])

    async def get_stale(self, key: str) -> Optional[tuple]:
        return await self.get(key)

    async def put(self, key: str, value: Any, ttl: int, as_of: str) -> None:
        json.dumps(value)  # L2 직렬화 계약 검증 / assert the L2 serialization contract
        self.puts += 1
        self.store[key] = (value, as_of, ttl)


# ---------------------------------------------------------------------------
# 고정 데이터 / Fixed data
# ---------------------------------------------------------------------------

def _quote(symbol: str, name: str, market: str, change_pct: float, volume: int, sector: str) -> Quote:
    return Quote(
        symbol=symbol,
        name=name,
        price=100.0,
        change=1.0,
        change_pct=change_pct,
        volume=volume,
        market=market,
        currency="USD" if market == "us" else "KRW",
        sector=sector,
        market_cap=None,
    )


FAKE_QUOTES = {
    "us": [
        _quote("AAPL", "Apple", "us", 1.5, 1_000, "Technology"),
        _quote("JPM", "JPMorgan Chase", "us", -0.5, 2_000, "Financial"),
    ],
    "kr": [
        _quote("005930.KS", "Samsung Electronics", "kr", 2.5, 3_000, "Semiconductor"),
        _quote("005380.KS", "Hyundai Motor", "kr", -1.5, 4_000, "Auto"),
    ],
}

FAKE_INDICES = [
    IndexQuote(symbol="^GSPC", name="S&P 500", value=5000.0, change=10.0, change_pct=0.2),
    IndexQuote(symbol="^KS11", name="KOSPI", value=2700.0, change=-5.0, change_pct=-0.18),
]

FAKE_INDICATORS = [
    Indicator(symbol="CL=F", name="WTI Oil", value=80.0, change=0.5, change_pct=0.63, unit="$"),
]

FAKE_NEWS = [
    NewsItem(
        id="feed0001",
        title="Markets rally on earnings",
        link="https://example.com/a",
        source="Yahoo",
        published="Fri, 01 Aug 2026 09:00:00 GMT",
        language="en",
    ),
]


# 종가가 전일보다 내려가는 날 - 수급 방향(하락)이 실제로 계산되는지 구분하기 위한 딥
# The one day whose close drops below the previous one, so a "down" investor direction is observable
DIP_DAY = 3


def _fake_candles() -> list[Candle]:
    candles = []
    for day in range(1, CHART_CANDLES + 1):
        close = 100.0 + day - (5.0 if day == DIP_DAY else 0.0)
        candles.append(
            Candle(
                time=f"2026-07-{day:02d}",
                open=close,
                high=close + 1.0,
                low=close - 1.0,
                close=close,
                volume=1_000 * day,
            )
        )
    return candles


# ---------------------------------------------------------------------------
# 서비스 페이크 / Service fakes
# ---------------------------------------------------------------------------

class FakeServices:
    """호출 횟수를 세고 예외를 주입할 수 있는 서비스 페이크 모음 / Service fakes with call counts and injectable errors."""

    def __init__(self) -> None:
        self.calls: Counter = Counter()
        self.errors: dict[str, Exception] = {}

    def _enter(self, name: str) -> None:
        self.calls[name] += 1
        error = self.errors.get(name)
        if error is not None:
            raise error

    # --- market_data (동기 / sync) ---
    def fetch_indices(self) -> list[IndexQuote]:
        self._enter("fetch_indices")
        return list(FAKE_INDICES)

    def fetch_indicators(self) -> list[Indicator]:
        self._enter("fetch_indicators")
        return list(FAKE_INDICATORS)

    def fetch_quotes(self, market: str) -> list[Quote]:
        self._enter("fetch_quotes")
        return [quote.model_copy() for quote in FAKE_QUOTES[market]]

    # --- charts (동기 / sync) ---
    def fetch_chart(self, symbol: str, period: str) -> ChartResponse:
        self._enter("fetch_chart")
        if period not in config.CHART_TTL:
            raise ValueError(f"unsupported chart period: {period!r}")
        candles = _fake_candles()
        return ChartResponse(
            symbol=symbol,
            period=period,
            candles=candles,
            ma5=[None] * len(candles),
            ma20=[None] * len(candles),
            signals=[],
        )

    # --- fundamentals (동기 / sync) ---
    def fetch_detail(self, symbol: str) -> StockDetailResponse:
        self._enter("fetch_detail")
        market = "kr" if symbol.upper().endswith((".KS", ".KQ")) else "us"
        return StockDetailResponse(
            symbol=symbol,
            name=config.STOCK_NAMES.get(symbol, symbol),
            market=market,
            currency="KRW" if market == "kr" else "USD",
            price=FAKE_DETAIL_PRICE,
            change=1.5,
            change_pct=0.8,
            prev_close=186.0,
            volume=1_234,
            sector=config.STOCK_SECTORS.get(symbol, ""),
            returns={"1w": 1.0, "1m": 2.0, "3m": 3.0, "1y": 4.0},
            # 느린 펀더멘털 - 실시간 시세 오버레이가 덮어쓰지 않아야 하는 필드
            # Slow fundamentals: the live-quote overlay must leave these alone
            pe_ratio=28.5,
            eps=6.1,
            beta=1.2,
            week52_high=200.0,
            week52_low=150.0,
            market_cap=3.0e12,
        )

    # --- news (비동기 / async) ---
    async def fetch_news(self) -> list[NewsItem]:
        self._enter("fetch_news")
        return list(FAKE_NEWS)

    async def fetch_company_news(self, symbol: str) -> list[NewsItem]:
        self._enter("fetch_company_news")
        return [FAKE_NEWS[0].model_copy(update={"title": f"{symbol} update"})]


# ---------------------------------------------------------------------------
# 픽스처 / Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def services(monkeypatch) -> FakeServices:
    """모든 데이터 서비스를 페이크로 교체 / Replace every data service with a fake."""
    fake = FakeServices()
    monkeypatch.setattr(market_data, "fetch_indices", fake.fetch_indices)
    monkeypatch.setattr(market_data, "fetch_indicators", fake.fetch_indicators)
    monkeypatch.setattr(market_data, "fetch_quotes", fake.fetch_quotes)
    monkeypatch.setattr(charts, "fetch_chart", fake.fetch_chart)
    monkeypatch.setattr(fundamentals, "fetch_detail", fake.fetch_detail)
    monkeypatch.setattr(news, "fetch_news", fake.fetch_news)
    monkeypatch.setattr(news, "fetch_company_news", fake.fetch_company_news)
    return fake


@pytest.fixture
def l2() -> FakeL2:
    return FakeL2()


@pytest.fixture
def state(l2: FakeL2) -> AppState:
    return AppState(cache=TieredCache(MemoryCache(), l2))


@pytest.fixture
def client(state: AppState, services: FakeServices) -> TestClient:
    """페이크 서비스 + 인메모리 캐시를 물린 앱 클라이언트 / App client wired to fake services and in-memory cache."""
    with TestClient(create_app(state)) as test_client:
        yield test_client
