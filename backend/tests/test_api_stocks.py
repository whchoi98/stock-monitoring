"""
stocks 라우트 테스트 - 심볼 검증(404), period 검증(422), 시뮬레이션 플래그, 캐시 키.
stocks route tests - symbol validation (404), period validation (422), simulation flag, cache keys.
"""
from __future__ import annotations

from typing import get_args

from app.api.stocks import Period
from app.core import config
from app.services.simulation import build_order_book
from tests.conftest import (
    DIP_DAY,
    FAKE_DETAIL_PRICE,
    FAKE_QUOTES,
    KR_SYMBOL,
    UNKNOWN_SYMBOL,
    US_SYMBOL,
)

ENVELOPE_KEYS = {"asOf", "marketOpen", "data"}

# quotes 캐시가 들고 있는 실시간 시세 (상세 캐시 가격과 다르다) / The live quote in the quotes cache (differs from the detail price)
LIVE_QUOTE = FAKE_QUOTES["us"][0]


def test_detail_returns_envelope_and_caches_under_symbol_key(client, state):
    """상세는 envelope + detail:{symbol} 키로 캐시 / Detail returns the envelope and caches under detail:{symbol}."""
    response = client.get(f"/api/stocks/{US_SYMBOL}")

    assert response.status_code == 200
    body = response.json()
    assert ENVELOPE_KEYS <= set(body)
    assert body["data"]["symbol"] == US_SYMBOL
    assert body["data"]["returns"]["1w"] == 1.0
    assert state.cache.l1.get(f"detail:{US_SYMBOL}") is not None


def test_detail_overlays_live_quote_price_on_cached_fundamentals(client):
    """
    상세의 가격 계열은 quotes 캐시(45초)에서, 나머지는 상세 캐시(12h)에서 온다.
    Price-like detail fields come from the 45s quotes cache; the rest stays on the 12h detail cache.
    """
    assert client.get("/api/market/quotes", params={"market": "us"}).status_code == 200

    data = client.get(f"/api/stocks/{US_SYMBOL}").json()["data"]

    # 실시간 시세로 덮어쓴 필드 / Fields overlaid from the live quote
    assert LIVE_QUOTE.price != FAKE_DETAIL_PRICE  # 픽스처가 실제로 다른 값인지 / the fixture really differs
    assert data["price"] == LIVE_QUOTE.price
    assert data["change"] == LIVE_QUOTE.change
    assert data["change_pct"] == LIVE_QUOTE.change_pct
    assert data["volume"] == LIVE_QUOTE.volume
    # 미러 필드도 함께 갱신된다 / The mirror fields follow
    assert data["day_change_pct"] == LIVE_QUOTE.change_pct
    # 느린 펀더멘털은 상세 캐시 그대로 / Slow fundamentals stay as cached
    assert (data["pe_ratio"], data["eps"], data["beta"]) == (28.5, 6.1, 1.2)
    assert (data["week52_high"], data["week52_low"]) == (200.0, 150.0)
    assert data["market_cap"] == 3.0e12


def test_detail_falls_back_to_cached_price_without_quotes_cache(client, services):
    """quotes 캐시가 없으면 상세 자체의 가격으로 폴백한다 (오류 아님) / Without a quotes cache the detail price is used (not an error)."""
    response = client.get(f"/api/stocks/{US_SYMBOL}")

    assert response.status_code == 200
    assert response.json()["data"]["price"] == FAKE_DETAIL_PRICE
    # 상세 라우트가 시장 전체 시세 조회를 유발하지 않는다 / The detail route triggers no market-wide quotes fetch
    assert services.calls["fetch_quotes"] == 0


def test_unknown_symbol_is_404_and_creates_no_cache_key(client, state):
    """유니버스 밖 심볼은 404이며 캐시 키/락을 만들지 않는다 / An off-universe symbol is 404 and creates no cache key or lock."""
    for path in (
        f"/api/stocks/{UNKNOWN_SYMBOL}",
        f"/api/stocks/{UNKNOWN_SYMBOL}/chart",
        f"/api/stocks/{UNKNOWN_SYMBOL}/news",
        f"/api/stocks/{UNKNOWN_SYMBOL}/orderbook",
        f"/api/stocks/{UNKNOWN_SYMBOL}/investors",
    ):
        assert client.get(path).status_code == 404, path

    # 락 맵은 검증된 심볼 유니버스로 제한된다 / The lock map stays bounded by the validated universe
    assert not [key for key in state.cache._locks if UNKNOWN_SYMBOL in key]
    assert not [key for key in state.cache.l1.store if UNKNOWN_SYMBOL in key]


def test_chart_period_choices_match_configured_ttls(client):
    """차트 period 후보는 CHART_TTL 키와 일치해야 한다 / The chart period choices must match the CHART_TTL keys."""
    assert set(get_args(Period)) == set(config.CHART_TTL)


def test_chart_returns_candles_and_rejects_bad_period(client, state):
    """유효 period는 200 + 캔들, 잘못된 period는 422 / A valid period returns candles; an invalid one is 422."""
    response = client.get(f"/api/stocks/{US_SYMBOL}/chart", params={"period": "3m"})

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["period"] == "3m"
    assert len(data["candles"]) == len(data["ma5"]) == len(data["ma20"])
    assert state.cache.l1.get(f"chart:{US_SYMBOL}:3m") is not None

    assert client.get(f"/api/stocks/{US_SYMBOL}/chart", params={"period": "10y"}).status_code == 422


def test_stock_news_returns_company_items(client):
    """종목 뉴스는 해당 심볼 기사 리스트 / Per-symbol news returns that symbol's items."""
    response = client.get(f"/api/stocks/{KR_SYMBOL}/news")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data[0]["title"] == f"{KR_SYMBOL} update"


def test_orderbook_is_flagged_simulated_with_ten_levels_per_side(client):
    """호가는 simulated=true + 매도/매수 각 10단계 / The order book is flagged simulated with 10 levels per side."""
    response = client.get(f"/api/stocks/{US_SYMBOL}/orderbook")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["simulated"] is True
    entries = data["entries"]
    assert sum(1 for entry in entries if entry["side"] == "ask") == 10
    assert sum(1 for entry in entries if entry["side"] == "bid") == 10


def test_orderbook_seeds_from_the_live_price(client):
    """
    호가는 실시간 가격에서 파생된다 (12시간 캐시된 상세 가격이 아니다).
    The order book derives from the live price, not the 12h-cached detail price.
    """
    assert client.get("/api/market/quotes", params={"market": "us"}).status_code == 200

    data = client.get(f"/api/stocks/{US_SYMBOL}/orderbook").json()["data"]

    live_price = LIVE_QUOTE.price
    expected = [
        entry.model_dump(mode="json")
        for entry in build_order_book(live_price, "us", int(live_price * 100))
    ]
    stale = [
        entry.model_dump(mode="json")
        for entry in build_order_book(FAKE_DETAIL_PRICE, "us", int(FAKE_DETAIL_PRICE * 100))
    ]
    assert data["price"] == live_price
    assert data["entries"] == expected
    assert data["entries"] != stale


def test_investors_is_flagged_simulated_with_ten_days(client):
    """수급은 simulated=true + 최근 10일 / Investor flows are flagged simulated and cover the last 10 days."""
    response = client.get(f"/api/stocks/{KR_SYMBOL}/investors")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["simulated"] is True
    assert len(data["rows"]) == 10
    assert {"date", "individual", "foreign", "institution"} == set(data["rows"][0])

    # 첫 행도 전일 종가와 비교된다 (11일치를 넣고 첫 행을 버린 결과): 하락일이면 기관 순매도·개인 순매수
    # The first row is compared against a real previous close (11 rows in, first dropped): on a down day
    # institutions are net sellers and individuals net buyers.
    first = data["rows"][0]
    assert first["date"] == f"2026-07-{DIP_DAY:02d}"
    assert first["institution"] < 0
    assert first["individual"] > 0


def test_symbol_is_normalized_to_the_universe_form(client, state, services):
    """소문자 심볼은 정규화되어 같은 캐시 키를 쓴다 / A lowercase symbol is normalized onto the same cache key."""
    assert client.get(f"/api/stocks/{US_SYMBOL.lower()}").status_code == 200
    assert client.get(f"/api/stocks/{US_SYMBOL}").status_code == 200

    assert services.calls["fetch_detail"] == 1
    assert list(state.cache._locks) == [f"detail:{US_SYMBOL}"]
