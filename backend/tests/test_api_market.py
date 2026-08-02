"""
market/health 라우트 테스트 - envelope, 캐시 경유, 잘못된 market, 소스 상태.
market/health route tests - envelope, cache reuse, invalid market, source status.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import FAKE_NEWS

ENVELOPE_KEYS = {"asOf", "marketOpen", "data"}


def test_overview_returns_envelope_with_all_sections(client):
    """overview는 envelope + 지수/지표/요약/섹터를 담는다 / overview carries the envelope plus all four sections."""
    response = client.get("/api/market/overview")

    assert response.status_code == 200
    body = response.json()
    assert ENVELOPE_KEYS <= set(body)
    assert isinstance(body["marketOpen"], bool)

    data = body["data"]
    assert {"indices", "indicators", "summary", "sectors"} == set(data)
    assert data["indices"][0]["symbol"] == "^GSPC"
    assert data["indicators"][0]["symbol"] == "CL=F"
    # summary는 시장별 breadth/movers, sectors는 시장별 섹터 리스트
    assert data["summary"]["us"]["advancing"] == 1
    assert data["summary"]["kr"]["declining"] == 1
    assert {"us", "kr"} == set(data["sectors"])
    assert data["sectors"]["us"][0]["sector"] in {"Technology", "Financial"}


def test_overview_second_call_is_served_from_cache(client, services):
    """두 번째 overview 호출은 업스트림을 다시 때리지 않는다 / The second overview call must not re-hit upstream."""
    assert client.get("/api/market/overview").status_code == 200
    assert client.get("/api/market/overview").status_code == 200

    assert services.calls["fetch_indices"] == 1
    assert services.calls["fetch_quotes"] == 2  # us + kr, 각 1회 / one per market


def test_quotes_returns_market_rows_under_fixed_cache_key(client, state, l2):
    """quotes?market=us는 고정 키 quotes:us로 캐시된다 / quotes?market=us caches under the fixed key quotes:us."""
    response = client.get("/api/market/quotes", params={"market": "us"})

    assert response.status_code == 200
    data = response.json()["data"]
    assert [row["symbol"] for row in data] == ["AAPL", "JPM"]
    assert state.cache.l1.get("quotes:us") is not None
    assert "quotes:us" in l2.store


def test_quotes_rejects_unknown_market_with_422(client):
    """us/kr 외의 market 값과 누락은 422 / Any market other than us/kr, and a missing one, are 422."""
    assert client.get("/api/market/quotes", params={"market": "xx"}).status_code == 422
    assert client.get("/api/market/quotes").status_code == 422


def test_news_returns_feed_items(client):
    """news 피드는 envelope에 담긴 아이템 리스트 / The news feed is an item list inside the envelope."""
    response = client.get("/api/market/news")

    assert response.status_code == 200
    data = response.json()["data"]
    assert [item["title"] for item in data] == [FAKE_NEWS[0].title]


def test_health_is_200_with_sources_and_cache_age(client):
    """health는 항상 200이고 소스 상태와 캐시 age를 보고한다 / health is always 200 and reports source status plus cache age."""
    before = client.get("/api/health")
    assert before.status_code == 200
    assert before.json()["status"] == "ok"
    assert "yahoo" in before.json()["sources"]
    assert before.json()["cacheAge"] == {}

    client.get("/api/market/overview")
    after = client.get("/api/health").json()
    assert after["sources"]["yahoo"] == "ok"
    assert after["cacheAge"]["overview"] >= 0
    assert after["cacheAge"]["quotes:kr"] >= 0


def test_health_stays_200_without_app_context():
    """컨텍스트가 없어도 헬스는 200 (ALB는 외부 의존성으로 인스턴스를 죽이지 않는다) / Health stays 200 without a context."""
    app = create_app()
    del app.state.ctx

    with TestClient(app) as bare_client:
        response = bare_client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "sources": {}, "cacheAge": {}}


def test_upstream_failure_is_503_and_marks_source_degraded(client, services, state):
    """업스트림 실패는 조용히 빈 응답을 주지 않고 503 + degraded 마킹 / An upstream failure yields 503 and a degraded mark, never a silent empty body."""
    services.errors["fetch_quotes"] = RuntimeError("yahoo down")

    response = client.get("/api/market/quotes", params={"market": "us"})

    assert response.status_code == 503
    assert state.source_status["yahoo"] == "degraded"
    assert client.get("/api/health").json()["sources"]["yahoo"] == "degraded"
