"""
stocks 라우트 테스트 - 심볼 검증(404), period 검증(422), 시뮬레이션 플래그, 캐시 키.
stocks route tests - symbol validation (404), period validation (422), simulation flag, cache keys.
"""
from __future__ import annotations

from typing import get_args

from app.api.stocks import Period
from app.core import config
from tests.conftest import KR_SYMBOL, UNKNOWN_SYMBOL, US_SYMBOL

ENVELOPE_KEYS = {"asOf", "marketOpen", "data"}


def test_detail_returns_envelope_and_caches_under_symbol_key(client, state):
    """상세는 envelope + detail:{symbol} 키로 캐시 / Detail returns the envelope and caches under detail:{symbol}."""
    response = client.get(f"/api/stocks/{US_SYMBOL}")

    assert response.status_code == 200
    body = response.json()
    assert ENVELOPE_KEYS <= set(body)
    assert body["data"]["symbol"] == US_SYMBOL
    assert body["data"]["returns"]["1w"] == 1.0
    assert state.cache.l1.get(f"detail:{US_SYMBOL}") is not None


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


def test_investors_is_flagged_simulated_with_ten_days(client):
    """수급은 simulated=true + 최근 10일 / Investor flows are flagged simulated and cover the last 10 days."""
    response = client.get(f"/api/stocks/{KR_SYMBOL}/investors")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["simulated"] is True
    assert len(data["rows"]) == 10
    assert {"date", "individual", "foreign", "institution"} == set(data["rows"][0])


def test_symbol_is_normalized_to_the_universe_form(client, state, services):
    """소문자 심볼은 정규화되어 같은 캐시 키를 쓴다 / A lowercase symbol is normalized onto the same cache key."""
    assert client.get(f"/api/stocks/{US_SYMBOL.lower()}").status_code == 200
    assert client.get(f"/api/stocks/{US_SYMBOL}").status_code == 200

    assert services.calls["fetch_detail"] == 1
    assert list(state.cache._locks) == [f"detail:{US_SYMBOL}"]
