"""
market/health 라우트 테스트 - envelope, 캐시 경유, 잘못된 market, 소스 상태.
market/health route tests - envelope, cache reuse, invalid market, source status.
"""
from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient

from app.api import deps
from app.api import market as market_api
from app.main import create_app
from app.services import market_data
from tests.conftest import FAKE_NEWS

ENVELOPE_KEYS = {"asOf", "marketOpen", "data"}


def _partial_us(services):
    """US만 요청 심볼보다 한 행 적게 반환하는 `fetch_quotes` / A `fetch_quotes` where only US is one row short."""
    def partial(market: str):
        quotes = services.fetch_quotes(market)
        return quotes[:-1] if market == "us" else quotes

    return partial


def _evict(state, l2, *keys: str) -> None:
    """
    L1·L2에서 키를 지워 콜드 상태를 만든다 / Drop keys from L1 and L2 to force a cold fetch.

    캐시된 값이 있으면 fetcher가 아예 돌지 않으므로, 같은 키를 다시 조회하는 대조군은 이렇게
    콜드로 되돌려야 성립한다.
    A cached value means the fetcher never runs, so a control that re-fetches the *same* key only holds
    once the key is cold again.
    """
    for key in keys:
        state.cache.l1.store.pop(key, None)
        l2.store.pop(key, None)


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


@pytest.mark.parametrize(
    ("instant", "us_open", "kr_open"),
    [
        ("2026-09-10T02:00:00+00:00", False, True),
        ("2026-09-10T14:00:00+00:00", True, False),
        ("2026-09-13T02:00:00+00:00", False, False),
    ],
)
def test_quotes_report_the_requested_markets_hours(client, market_clock, instant, us_open, kr_open):
    """시세의 장중 표시는 요청 시장에 한정 / Quote marketOpen describes the requested market."""
    market_clock(instant)

    for market, expected in (("us", us_open), ("kr", kr_open)):
        response = client.get("/api/market/quotes", params={"market": market})
        assert response.status_code == 200
        assert response.json()["marketOpen"] is expected, market

    # 여러 시장을 포함하는 응답은 기존 OR 규약 유지 / Mixed-market endpoints retain the aggregate flag.
    for path in ("/api/market/overview", "/api/market/news"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.json()["marketOpen"] is (us_open or kr_open)


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


def test_partial_quotes_are_served_but_reported_degraded(client, services, state, l2, monkeypatch):
    """
    부분 성공은 200으로 서빙하되 헬스에서 degraded로 드러낸다 / A partial is served with 200 but reported degraded.

    `fetch_quotes`는 커버리지 60~99%를 성공으로 반환한다(하한 미달만 예외). 이것을 그냥 ok로
    마킹하면 US 테이블이 50행 중 30행만 보이는 동안 `/api/health`가 "완전 정상"이라고 보고한다.
    `fetch_quotes` returns 60-99% coverage as a success (only below the floor raises). Marking that ok
    would let `/api/health` claim full health while the US table shows 30 of 50 rows.

    대조군은 **같은 시장(US)의 전량 재조회**다. 다른 시장(KR)을 조회해 ok가 되는 것은 마킹이
    펄럭인다는 사실만 보여주고, "정상 커버리지를 degraded로 오판하지 않는다"는 것은 증명하지 못한다.
    The control is a *full re-fetch of the same market*. Fetching a different market (KR) only shows the
    mark flaps; it never proves a healthy coverage is not falsely reported degraded.
    """
    monkeypatch.setattr(market_data, "fetch_quotes", _partial_us(services))

    response = client.get("/api/market/quotes", params={"market": "us"})
    assert response.status_code == 200  # 부분 결과는 그대로 서빙 / the partial rows are still served
    assert len(response.json()["data"]) == len(market_data.market_symbols("us")) - 1
    assert state.source_status["yahoo"] == "degraded"
    assert client.get("/api/health").json()["sources"]["yahoo"] == "degraded"

    # 대조군: US를 콜드로 되돌리고 전량으로 다시 조회하면 ok / control: same market, cold, full coverage
    monkeypatch.setattr(market_data, "fetch_quotes", services.fetch_quotes)
    _evict(state, l2, deps.key_quotes("us"))

    full = client.get("/api/market/quotes", params={"market": "us"})
    assert len(full.json()["data"]) == len(market_data.market_symbols("us"))
    assert client.get("/api/health").json()["sources"]["yahoo"] == "ok"


def test_cold_overview_with_a_partial_market_is_reported_degraded(client, services, state, monkeypatch):
    """
    콜드 overview가 짧은 테이블을 서빙하면 yahoo는 degraded여야 한다 (마지막 마킹이 덮어쓰지 않는다).
    A cold overview serving a short table must report yahoo degraded; the last mark must not erase it.

    `overview_payload`는 내부에서 `cached_quotes`를 호출하고, 그 안쪽 `deps.cached`가 부분 성공을
    degraded로 마킹한다. 그런데 바깥쪽 `deps.cached(KEY_OVERVIEW, ...)`가 평범한 dict를 받으면
    무조건 ok로 마킹해 방금의 degraded를 지운다(last-writer-wins) — 콜드 overview 한 번으로
    `yahoo: ok` + 짧은 테이블이라는 정확히 감추고 싶었던 조합이 나온다.
    `overview_payload` calls `cached_quotes`, whose inner `deps.cached` marks a partial degraded - but if
    the outer `deps.cached(KEY_OVERVIEW, ...)` receives a plain dict it unconditionally marks ok and wipes
    that (last-writer-wins), so one cold overview reports `yahoo: ok` while serving a short table.
    """
    monkeypatch.setattr(market_data, "fetch_quotes", _partial_us(services))

    response = client.get("/api/market/overview")

    assert response.status_code == 200  # 짧은 테이블이라도 서빙한다 / the short table is still served
    summary = response.json()["data"]["summary"]["us"]
    # 전량이면 declining이 1이다 — 짧은 테이블이 그대로 집계됐음을 보인다 / a full table has declining == 1
    assert summary["advancing"] == 1 and summary["declining"] == 0
    assert state.source_status["yahoo"] == "degraded"
    assert client.get("/api/health").json()["sources"]["yahoo"] == "degraded"


def test_cold_overview_with_full_coverage_reports_ok(client, state):
    """
    대조군: 전량 커버리지의 콜드 overview는 ok다 / Control: a cold overview with full coverage is ok.

    위 테스트와 짝을 이룬다 — 하나는 거짓 ok를, 하나는 거짓 degraded를 막는다.
    Paired with the test above: one forbids a false ok, this one forbids a false degrade.
    """
    assert client.get("/api/market/overview").status_code == 200

    assert state.source_status["yahoo"] == "ok"
    assert client.get("/api/health").json()["sources"]["yahoo"] == "ok"


def test_cold_overview_with_truncated_indices_is_reported_degraded(client, state, monkeypatch):
    """
    지수/지표가 데드라인에 잘려도 헬스가 감추지 않는다 / A deadline-truncated index list must not look healthy.

    `fetch_indices`/`fetch_indicators`는 예산이 만료되면 남은 심볼을 포기하고 파싱된 행만 반환한다
    (예외 없음). 예산이 요청 1건 상한(8s)보다 작으므로 느린 요청 하나가 나머지 행 전부를 삼킬 수
    있는데, 그것이 `yahoo: ok`로 보고되면 대시보드가 조용히 반쪽이 된다.
    `fetch_indices`/`fetch_indicators` drop the remaining symbols on budget expiry and return what they
    parsed (nothing raises). Since the budget is smaller than the 8s per-request cap, one slow request can
    swallow every remaining row - reported as `yahoo: ok`, the dashboard silently halves.
    """
    monkeypatch.setattr(market_data, "fetch_indices", lambda: [])

    response = client.get("/api/market/overview")

    assert response.status_code == 200
    assert response.json()["data"]["indices"] == []
    assert client.get("/api/health").json()["sources"]["yahoo"] == "degraded"


def test_coverage_shortfall_is_full_for_quotes_and_a_floor_for_additive_rows():
    """
    커버리지 판정 임계값: 시세는 전량, 지수·지표는 하한 / Thresholds: full for quotes, a floor for additive rows.

    시세 행은 제품 그 자체다 — 한 행이 빠지면 사용자가 보려던 종목이 사라지므로 전량 미달은 곧
    degraded다. 반면 지수·지표는 대시보드의 추가 행이고 한 심볼이 NaN/휴장으로 빠지는 일은 일상
    이라, "한 행이라도 빠지면 degraded"는 yahoo를 사실상 상시 degraded로 만들어 신호의 뜻을
    없앤다. 그래서 시세와 같은 60% 하한을 쓴다 — 데드라인이 여러 행을 한꺼번에 삼키는 모양은
    잡아내고, 한두 행의 잡음은 흘려보낸다.
    A quote row *is* the product: one missing row is a symbol the user wanted and cannot see, so anything
    below full coverage is degraded. Indices and indicators are additive dashboard rows where a single
    NaN/holiday gap is routine, so "any missing row degrades" would pin yahoo to degraded and destroy the
    signal's meaning. They therefore reuse the quotes' 60% floor: it catches the deadline shape (many rows
    lost at once) and ignores one- or two-row noise.
    """
    assert market_api.coverage_shortfall("quotes:us", 50, 50, market_api.FULL_COVERAGE) is None
    shortfall = market_api.coverage_shortfall("quotes:us", 49, 50, market_api.FULL_COVERAGE)
    assert shortfall == {"kind": "quotes:us", "parsed": 49, "requested": 50, "minimum": 1.0}

    # 지수 5심볼: 1행 결손(80%)은 잡음, 3행 결손(40%)은 데드라인 절단 / 1 of 5 missing is noise, 3 is truncation
    assert market_api.coverage_shortfall("indices", 4, 5, market_api.ADDITIVE_MIN_COVERAGE) is None
    assert market_api.coverage_shortfall("indices", 2, 5, market_api.ADDITIVE_MIN_COVERAGE) is not None
    assert market_api.ADDITIVE_MIN_COVERAGE == market_data.QUOTE_MIN_COVERAGE

    # 요청 심볼이 0이면 판정할 것이 없다 (0으로 나누지 않는다) / nothing to judge with no requested symbol
    assert market_api.coverage_shortfall("indices", 0, 0, market_api.ADDITIVE_MIN_COVERAGE) is None


async def test_partial_warning_survives_a_detail_that_collides_with_reserved_fields(state, caplog):
    """
    `Partial.detail`이 예약 이름을 담아도 부분 성공 경고가 사라지지 않는다.
    A `Partial.detail` colliding with reserved field names must not delete the partial warning.

    `detail`은 fetcher가 만드는 임의 dict다. 거기에 `key`/`source`/`event`가 들어오면 예전 호출
    (`_warn(..., key=key, source=source, **detail)`)이 TypeError로 죽어 — 조용한 실패를 막으려고
    넣은 로그가 조용히 사라진다. 충돌한 값은 `detail_*`로 보존한다.
    `detail` is an arbitrary fetcher-built dict; a `key`/`source`/`event` inside it made the old call die
    with a TypeError, deleting the very log that exists to prevent silent failure. Collisions are kept
    under a `detail_` prefix.
    """
    async def fetcher():
        return deps.Partial([1], {"key": "spoof", "source": "spoof", "event": "spoof", "parsed": 1})

    with caplog.at_level(logging.WARNING, logger="app.api.deps"):
        value, _as_of = await deps.cached(state, "quotes:us", 60, fetcher, deps.SOURCE_YAHOO)

    assert value == [1]  # 부분 결과는 그대로 서빙된다 / the partial value is still served
    assert state.source_status["yahoo"] == "degraded"
    payload = json.loads(caplog.records[-1].getMessage())
    assert payload["event"] == "route_fetch_partial"
    assert payload["key"] == "quotes:us" and payload["source"] == deps.SOURCE_YAHOO
    # 충돌한 값도 버리지 않는다 / the colliding values are preserved, not dropped
    assert payload["detail_key"] == "spoof" and payload["detail_event"] == "spoof"
    assert payload["parsed"] == 1


def test_upstream_failure_is_503_and_marks_source_degraded(client, services, state):
    """업스트림 실패는 조용히 빈 응답을 주지 않고 503 + degraded 마킹 / An upstream failure yields 503 and a degraded mark, never a silent empty body."""
    services.errors["fetch_quotes"] = RuntimeError("yahoo down")

    response = client.get("/api/market/quotes", params={"market": "us"})

    assert response.status_code == 503
    assert state.source_status["yahoo"] == "degraded"
    assert client.get("/api/health").json()["sources"]["yahoo"] == "degraded"


def test_quotes_carry_the_korean_name_field(client):
    """시세 행마다 `name_ko` 필드가 실린다 (유니버스 밖이면 null) / Every quote row carries `name_ko` (null outside the universe)."""
    rows = client.get("/api/market/quotes", params={"market": "us"}).json()["data"]
    assert rows
    assert all("name_ko" in row for row in rows)
