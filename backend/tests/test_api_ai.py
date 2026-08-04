"""
AI 라우트 테스트 - SSE 프로토콜(phase/delta/final), 레이트리밋(429 JSON), 결과 캐시, 오류 매핑(503/500/502).
AI route tests - the SSE protocol (phase/delta/final), rate limiting (429 JSON), the result cache and
error mapping (503/500/502).

Bedrock은 스트리밍 서비스 함수(`bedrock_ai.analyze_stock_stream`/`analyze_article_stream`)를
monkeypatch해서 대체한다(boto3는 건드리지 않는다). 기사 본문 조회(`news.fetch_article_content`)도
페이크다 - 네트워크 없음.
Bedrock is replaced by monkeypatching the streaming service functions (never boto3), and the article
fetch (`news.fetch_article_content`) is faked too, so no test touches the network.

두 엔드포인트는 `text/event-stream`을 돌려주므로 본문 단정은 final 이벤트의 data(`_final`)에 건다 -
스트림이 이미 시작된 뒤의 실패는 HTTP 상태가 아니라 final의 `{"error", "status"}`로 나온다.
Both endpoints answer with `text/event-stream`, so body assertions go through the final event's data
(`_final`): a failure after the stream started surfaces in `{"error", "status"}`, not in the HTTP status.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from typing import Any, AsyncIterator, Optional

import httpx
import pytest

from app.api import ai
from app.api.ratelimit import SlidingWindowLimiter
from app.core import config
from app.main import create_app
from app.services import bedrock_ai, news
from tests.conftest import FAKE_DETAIL_PRICE, FAKE_QUOTES, UNKNOWN_SYMBOL, US_SYMBOL

ENVELOPE_KEYS = {"asOf", "marketOpen", "data"}

# quotes 캐시(45초)가 들고 있는 실시간 시세 - 상세 캐시(12h) 가격과 다른 값이다
# The live quote in the 45s quotes cache, deliberately a different value from the 12h detail price
LIVE_QUOTE = FAKE_QUOTES["us"][0]

# 시나리오별 기본 델타 시퀀스 - 합치면 기존(블로킹) 분석 텍스트와 동일하다
# Per-scenario default delta sequences; joined they equal the analysis text the blocking path returned
STOCK_DELTAS = ["## 기술적 분석\n", "상승 ", "추세입니다."]
ARTICLE_DELTAS = ["## 요약\n", "실적이 ", "좋았습니다."]
STOCK_ANALYSIS = "".join(STOCK_DELTAS)
ARTICLE_ANALYSIS = "".join(ARTICLE_DELTAS)
ARTICLE_CONTENT = "기사 본문 단락 하나.\n\n두 번째 단락."

ARTICLE_URL = "https://example.com/news/1"
ARTICLE_BODY = {"url": ARTICLE_URL, "title": "삼성전자 실적 발표", "language": "ko"}
ARTICLE_KEY = f"ai:article:{hashlib.sha1(ARTICLE_URL.encode()).hexdigest()[:16]}"

# 레이트리밋 한도(3회)를 넘기지 않고 여러 번 호출하려면 서로 다른 IP가 필요하다
# Separate IPs are needed to make more calls than the per-IP limit (3) allows
XFF_FIRST = "1.2.3.4"
XFF = f"{XFF_FIRST}, 10.0.0.1"
XFF_SAME_CLIENT_OTHER_HOP = f"{XFF_FIRST}, 172.16.0.9"
XFF_OTHER_CLIENT = f"5.6.7.8, {XFF_FIRST}"

# CloudFront가 붙이는 뷰어 주소의 IP 부분 ("ip:port"에서 포트를 뗀 값) / IP part of the CloudFront viewer address
VIEWER_IP = "198.51.100.20"

# 한도(3)보다 많은 심볼: 캐시 히트가 아닌 진짜 200을 만들기 위해 요청마다 다른 심볼을 쓴다
# More symbols than the limit (3): each request uses its own symbol so every 200 is a real analysis
SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "META"]


# ---------------------------------------------------------------------------
# SSE 파싱 / SSE parsing
# ---------------------------------------------------------------------------

def _sse_events(body: str) -> list[tuple[str, dict]]:
    """SSE 본문을 (event, data dict) 리스트로 / Parse an SSE body into (event, data) pairs."""
    events = []
    for frame in body.strip().split("\n\n"):
        name, payload = None, []
        for line in frame.split("\n"):
            if line.startswith("event: "):
                name = line[len("event: "):]
            elif line.startswith("data: "):
                payload.append(line[len("data: "):])
        assert name is not None, f"frame without event name: {frame!r}"
        events.append((name, json.loads("\n".join(payload))))
    return events


def _events(response) -> list[tuple[str, dict]]:
    """SSE 응답을 이벤트 목록으로 (content-type까지 확인) / The response's events, content-type checked."""
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    return _sse_events(response.text)


def _names(events: list[tuple[str, dict]]) -> list[str]:
    """이벤트 이름 순서 / The event names in order."""
    return [name for name, _data in events]


def _phases(events: list[tuple[str, dict]]) -> list[str]:
    """phase 이벤트의 phase 값들 / The phase values of the phase events."""
    return [data["phase"] for name, data in events if name == "phase"]


def _deltas(events: list[tuple[str, dict]]) -> list[str]:
    """delta 이벤트의 텍스트들 / The texts of the delta events."""
    return [data["text"] for name, data in events if name == "delta"]


def _final(response) -> dict:
    """마지막 이벤트가 final임을 확인하고 그 data를 반환 / Assert the last event is final and return its data."""
    events = _events(response)
    name, data = events[-1]
    assert name == "final", f"last event is {name!r}, not final: {_names(events)}"
    return data


class FakeBedrock:
    """
    스트리밍 Bedrock/기사조회 페이크 - 호출 기록·델타 시퀀스·예외 주입.
    Streaming Bedrock and article-fetch fake with call records, delta sequences and injectable errors.

    `stream_deltas`가 None이면 시나리오 기본값(STOCK_DELTAS/ARTICLE_DELTAS)을 흘린다 - 합치면 기존
    분석 텍스트와 같으므로 "최종 텍스트" 단정이 그대로 유지된다.
    With `stream_deltas` unset each scenario streams its own default, whose join equals the analysis text
    the blocking fake used to return, so the "final text" assertions carry over unchanged.

    `error`는 첫 델타 **전에**, `stream_error`는 델타 일부를 낸 **뒤에** raise된다(mid-stream 실패 재현).
    `error` raises before the first delta; `stream_error` raises after partial deltas (a mid-stream failure).
    """

    def __init__(self) -> None:
        self.stock_calls: list = []
        self.article_calls: list = []
        self.fetched_urls: list = []
        self.error: Exception = None  # type: ignore[assignment]
        self.stream_error: Exception = None  # type: ignore[assignment]
        self.stream_deltas: Optional[list[str]] = None
        self.content: str = ARTICLE_CONTENT
        self.delay: float = 0.0
        self.fetch_delay: float = 0.0
        # 동시 실행 관측용 / For observing concurrent execution
        self._lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0
        self.fetch_in_flight = 0
        self.max_fetch_in_flight = 0

    def _enter(self) -> None:
        with self._lock:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)

    def _exit(self) -> None:
        with self._lock:
            self.in_flight -= 1

    async def _pause(self) -> None:
        """델타 사이 지연 (동시성 관측용) / The between-delta delay used to observe concurrency."""
        if self.delay:
            await asyncio.sleep(self.delay)

    async def _stream(self, deltas: list[str]) -> AsyncIterator[str]:
        self._enter()
        try:
            await self._pause()
            if self.error is not None:
                raise self.error
            for delta in deltas:
                yield delta
                await self._pause()
                if self.stream_error is not None:
                    raise self.stream_error
        finally:
            self._exit()

    def _sequence(self, default: list[str]) -> list[str]:
        return default if self.stream_deltas is None else self.stream_deltas

    # 실제 함수처럼 호출 시점에 즉시 기록한다 (프롬프트 조립이 eager이므로)
    # Recorded eagerly at call time, mirroring the real functions' eager prompt assembly
    def analyze_stock_stream(self, **kwargs: Any) -> AsyncIterator[str]:
        self.stock_calls.append(kwargs)
        return self._stream(self._sequence(STOCK_DELTAS))

    def analyze_article_stream(self, title: str, content: str, is_korean: bool) -> AsyncIterator[str]:
        self.article_calls.append((title, content, is_korean))
        return self._stream(self._sequence(ARTICLE_DELTAS))

    async def fetch_article_content(self, url: str) -> str:
        self.fetched_urls.append(url)
        # fetch 동시 실행 관측 (2026-08-03 보안 리뷰 F2 — fetch도 전역 세마포어 안에서 돌아야 한다)
        # Observes concurrent fetches (security review F2: fetches must run inside the global semaphore)
        with self._lock:
            self.fetch_in_flight += 1
            self.max_fetch_in_flight = max(self.max_fetch_in_flight, self.fetch_in_flight)
        try:
            if self.fetch_delay:
                await asyncio.sleep(self.fetch_delay)
            return self.content
        finally:
            with self._lock:
                self.fetch_in_flight -= 1


@pytest.fixture
def bedrock(monkeypatch) -> FakeBedrock:
    """스트리밍 분석 2종 + 기사 본문 조회를 페이크로 교체 / Replace both streaming analyses and the article fetch."""
    fake = FakeBedrock()
    monkeypatch.setattr(bedrock_ai, "analyze_stock_stream", fake.analyze_stock_stream)
    monkeypatch.setattr(bedrock_ai, "analyze_article_stream", fake.analyze_article_stream)
    monkeypatch.setattr(news, "fetch_article_content", fake.fetch_article_content)
    return fake


# ---------------------------------------------------------------------------
# 종목 분석 / Stock analysis
# ---------------------------------------------------------------------------

def test_stock_stream_emits_phase_deltas_then_final(client, bedrock):
    """
    주식 스트림: phase → delta* → final, 델타 합 == 최종 분석 / phase, deltas, then a final whose analysis equals the joined deltas.

    첫 이벤트는 입력 수집·Bedrock 호출보다 **먼저** 나간다 (TTFB ~0초 → CloudFront idle 카운터 리셋).
    The first event precedes input gathering and the Bedrock call, so TTFB is ~0s and the CloudFront idle
    counter starts resetting immediately.
    """
    bedrock.stream_deltas = ["## 분석", "\n첫 ", "문단"]

    response = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    events = _events(response)
    assert events[0] == ("phase", {"phase": "analyzing"})
    assert _deltas(events) == bedrock.stream_deltas
    # 프로토콜에 없는 이벤트는 없다 / no event outside the protocol
    assert set(_names(events)) == {"phase", "delta", "final"}
    final = _final(response)
    assert set(final) == ENVELOPE_KEYS      # 기존 envelope 형태 / the existing envelope shape
    assert final["data"] == {"symbol": US_SYMBOL, "analysis": "".join(bedrock.stream_deltas)}


def test_stock_final_carries_cached_facts_and_caches_the_analysis(client, bedrock, state):
    """final은 분석 텍스트를 담고 프롬프트 입력은 캐시된 상세/뉴스에서 온다 / The final carries the analysis; prompt inputs come from the cached detail and news."""
    response = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    final = _final(response)
    assert ENVELOPE_KEYS <= set(final)
    assert final["data"] == {"symbol": US_SYMBOL, "analysis": STOCK_ANALYSIS}
    cached = state.cache.l1.get(f"ai:stock:{US_SYMBOL}")
    assert cached is not None
    # 클라이언트가 본 asOf는 캐시가 찍은 값 그대로다 (재요청 시 asOf가 뒤로 튀지 않는다)
    # The asOf the client saw is exactly the one the cache stamped, so a repeat never moves it backwards
    assert final["asOf"] == cached[1]
    # 분석 캐시의 TTL은 AI_TTL(6h)이다 - L2 엔트리에 기록된 ttl로 확인한다 (비용 방어의 크기)
    # The analysis is cached for AI_TTL (6h), read off the ttl the L2 entry recorded: the size of the
    # cost defense (a shorter TTL would silently multiply Bedrock spend)
    assert state.cache.l2.store[f"ai:stock:{US_SYMBOL}"][2] == config.AI_TTL
    assert bedrock.stock_calls == [
        {
            "symbol": US_SYMBOL,
            "name": "Apple",
            "price": FAKE_DETAIL_PRICE,
            "change_pct": 0.8,
            "pe_ratio": 28.5,
            "week52_high": 200.0,
            "week52_low": 150.0,
            "sector": "Technology",
            "market": "US",
            "news_titles": [f"{US_SYMBOL} update"],
        }
    ]


def test_stock_analysis_is_fed_the_overlaid_live_price(client, bedrock):
    """
    분석 입력의 가격 계열은 오버레이된 실시간 시세다 / The price-like inputs are the overlaid live quote.

    상세 캐시(12h)의 자체 가격으로 분석하면 장중 몇 시간 전 값을 두고 논평해 화면의 표·헤더와
    어긋난다 - 그래서 AI 라우트도 `stocks.detail_view`(오버레이 적용)를 쓴다.
    Analyzing the 12h detail cache's own price would comment on an hours-old number that contradicts the
    table and header on screen, so the AI route reads `stocks.detail_view` (overlay applied) as well.
    """
    assert client.get("/api/market/quotes", params={"market": "us"}).status_code == 200

    assert set(_final(client.post(f"/api/ai/stocks/{US_SYMBOL}"))) == ENVELOPE_KEYS

    assert LIVE_QUOTE.price != FAKE_DETAIL_PRICE   # 픽스처가 실제로 다른 값인지 / the fixture really differs
    call = bedrock.stock_calls[0]
    assert (call["price"], call["change_pct"]) == (LIVE_QUOTE.price, LIVE_QUOTE.change_pct)
    # 느린 펀더멘털은 상세 캐시에서 그대로 온다 (오버레이는 가격 계열만 덮는다)
    # Slow fundamentals still come from the detail cache: the overlay covers price-like fields only
    assert (call["pe_ratio"], call["week52_high"]) == (28.5, 200.0)


def test_cache_hit_emits_the_first_phase_then_final_only(client, bedrock, services):
    """
    캐시 히트는 delta 없이 첫 phase 뒤 곧바로 final / A cache hit goes straight to final after the first phase.

    첫 phase는 캐시 조회보다 앞이라 히트에서도 나간다 (프론트 코드 경로가 하나로 유지된다).
    The first phase precedes the cache probe, so a hit emits it too and the frontend keeps one code path.
    """
    first = client.post(f"/api/ai/stocks/{US_SYMBOL}")
    second = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    assert _names(_events(second)) == ["phase", "final"]
    assert _final(first)["data"] == _final(second)["data"]
    assert _final(first)["asOf"] == _final(second)["asOf"]
    assert len(bedrock.stock_calls) == 1
    # 상세/뉴스도 캐시에서 나온다 (AI 재호출이 업스트림을 다시 때리지 않는다)
    # The detail and news come from the cache too (a repeat AI call never re-hits upstream)
    assert services.calls["fetch_detail"] == 1
    assert services.calls["fetch_company_news"] == 1


def test_successful_analysis_marks_bedrock_source_ok(client, bedrock):
    """성공은 헬스의 bedrock 소스 상태에 반영된다 / Success is reflected in the health bedrock source status."""
    assert ENVELOPE_KEYS <= set(_final(client.post(f"/api/ai/stocks/{US_SYMBOL}")))

    assert client.get("/api/health").json()["sources"]["bedrock"] == "ok"


def test_unknown_symbol_is_404_and_creates_no_cache_key(client, bedrock, state):
    """유니버스 밖 심볼은 404이며 캐시 키를 만들지 않는다 / An off-universe symbol is 404 and creates no cache key."""
    assert client.post(f"/api/ai/stocks/{UNKNOWN_SYMBOL}").status_code == 404

    assert not bedrock.stock_calls
    assert not [key for key in state.cache.l1.store if UNKNOWN_SYMBOL in key]


# ---------------------------------------------------------------------------
# 레이트리밋 / Rate limiting
# ---------------------------------------------------------------------------

def test_rate_limit_stays_json_429_before_the_stream(client, bedrock):
    """
    같은 IP의 4번째 요청은 429 + 고정 본문 (SSE 아님) / The fourth request from one IP is a 429 JSON body, not SSE.

    한도 판정은 스트림 시작 전이므로 응답이 SSE로 승격되지 않는다 (기존 클라이언트 계약 유지).
    The limit is decided before the stream starts, so the response never becomes SSE.
    """
    for symbol in SYMBOLS[:config.AI_RATE_PER_MIN]:
        assert client.post(f"/api/ai/stocks/{symbol}").status_code == 200

    blocked = client.post(f"/api/ai/stocks/{SYMBOLS[config.AI_RATE_PER_MIN]}")

    assert blocked.status_code == 429
    assert blocked.headers["content-type"].startswith("application/json")
    assert blocked.headers["retry-after"] == "60"
    assert blocked.json() == {"detail": "rate_limited", "retryAfter": 60}
    # 차단된 요청은 Bedrock에 도달하지 않는다 / A blocked request never reaches Bedrock
    assert len(bedrock.stock_calls) == config.AI_RATE_PER_MIN


def test_cache_hits_still_spend_the_rate_limit_budget(client, bedrock):
    """레이트리밋은 캐시보다 앞이다: 같은 심볼 반복도 4번째는 429 / The limit precedes the cache, so even a repeat symbol is 429 on the fourth call."""
    for _ in range(config.AI_RATE_PER_MIN):
        assert client.post(f"/api/ai/stocks/{US_SYMBOL}").status_code == 200

    blocked = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    assert blocked.status_code == 429
    assert len(bedrock.stock_calls) == 1  # 2·3번째는 캐시 히트 / calls two and three were cache hits


def test_rate_limit_falls_back_to_the_first_forwarded_ip_without_a_viewer_address(client, bedrock):
    """
    CloudFront-Viewer-Address가 없으면 X-Forwarded-For 첫 항목이 기준이다 (로컬 개발 경로).
    Without CloudFront-Viewer-Address the first X-Forwarded-For entry keys the limit (the local-dev path).
    """
    for symbol in SYMBOLS[:config.AI_RATE_PER_MIN]:
        assert client.post(f"/api/ai/stocks/{symbol}", headers={"X-Forwarded-For": XFF}).status_code == 200

    # 같은 첫 IP + 다른 하위 홉 -> 같은 예산을 쓴다 / Same first IP, different downstream hop: same budget
    blocked = client.post(
        f"/api/ai/stocks/{SYMBOLS[3]}", headers={"X-Forwarded-For": XFF_SAME_CLIENT_OTHER_HOP}
    )
    # 다른 첫 IP -> 별도 예산 (첫 항목만 본다는 증거) / A different first IP has its own budget
    allowed = client.post(f"/api/ai/stocks/{SYMBOLS[4]}", headers={"X-Forwarded-For": XFF_OTHER_CLIENT})

    assert blocked.status_code == 429
    assert allowed.status_code == 200
    assert len(bedrock.stock_calls) == config.AI_RATE_PER_MIN + 1


def test_forged_forwarded_for_cannot_rotate_the_budget_behind_cloudfront(client, bedrock):
    """
    CloudFront-Viewer-Address가 있으면 위조된 X-Forwarded-For로 예산을 새로 딸 수 없다.
    With CloudFront-Viewer-Address present, a forged X-Forwarded-For cannot buy a fresh budget.

    요청마다 XFF 첫 항목을 바꿔도 (예전 구현이라면 매번 새 예산) 뷰어 주소가 같으면 4번째는 429다.
    Every request rotates the first XFF entry - which used to mint a new budget each time - yet the same
    viewer address makes the fourth request a 429.
    """
    viewer = {"CloudFront-Viewer-Address": f"{VIEWER_IP}:53210"}
    for index, symbol in enumerate(SYMBOLS[:config.AI_RATE_PER_MIN]):
        forged = {"X-Forwarded-For": f"203.0.113.{index}", **viewer}
        assert client.post(f"/api/ai/stocks/{symbol}", headers=forged).status_code == 200

    blocked = client.post(
        f"/api/ai/stocks/{SYMBOLS[3]}",
        headers={"X-Forwarded-For": "203.0.113.99", **viewer},
    )

    assert blocked.status_code == 429
    assert blocked.json() == {"detail": "rate_limited", "retryAfter": 60}
    assert len(bedrock.stock_calls) == config.AI_RATE_PER_MIN


def test_viewer_address_is_keyed_without_its_port(client, bedrock):
    """
    포트는 키에서 제거된다 - 같은 IP의 다른 포트는 같은 예산이다 / The port is stripped: another port is the same budget.

    포트를 남기면 커넥션마다 키가 달라져 한도가 사실상 사라진다.
    Keeping the port would give every connection its own key, which effectively removes the limit.
    """
    for index, symbol in enumerate(SYMBOLS[:config.AI_RATE_PER_MIN]):
        headers = {"CloudFront-Viewer-Address": f"{VIEWER_IP}:{40000 + index}"}
        assert client.post(f"/api/ai/stocks/{symbol}", headers=headers).status_code == 200

    blocked = client.post(
        f"/api/ai/stocks/{SYMBOLS[3]}",
        headers={"CloudFront-Viewer-Address": f"{VIEWER_IP}:59999"},
    )

    assert blocked.status_code == 429
    # 리미터가 실제로 쓴 키가 포트 없는 IP다 / The key the limiter actually used is the port-free IP
    assert set(client.app.state.ai_limiter._hits) == {VIEWER_IP}


def test_ipv6_viewer_address_parses_at_the_last_colon(client, bedrock):
    """
    IPv6 뷰어 주소는 마지막 콜론에서만 잘린다 / An IPv6 viewer address splits only at its last colon.

    IPv6 주소 자체가 콜론을 포함하므로 첫 콜론에서 자르면 `2001`처럼 뭉개져 서로 다른 클라이언트가
    한 예산을 공유해버린다.
    An IPv6 address contains colons, so splitting at the first one would collapse it to `2001` and make
    unrelated clients share a single budget.
    """
    first = "2001:db8::1"
    second = "2001:db8::2"
    for symbol in SYMBOLS[:config.AI_RATE_PER_MIN]:
        headers = {"CloudFront-Viewer-Address": f"{first}:53210"}
        assert client.post(f"/api/ai/stocks/{symbol}", headers=headers).status_code == 200

    blocked = client.post(
        f"/api/ai/stocks/{SYMBOLS[3]}", headers={"CloudFront-Viewer-Address": f"{first}:40000"}
    )
    other = client.post(
        f"/api/ai/stocks/{SYMBOLS[4]}", headers={"CloudFront-Viewer-Address": f"{second}:40000"}
    )

    assert blocked.status_code == 429
    assert other.status_code == 200      # 다른 IPv6는 별도 예산 / a different IPv6 gets its own budget
    assert set(client.app.state.ai_limiter._hits) == {first, second}


@pytest.mark.parametrize("value,expected", [
    ("203.0.113.7:53210", "203.0.113.7"),
    ("2001:db8::1:53210", "2001:db8::1"),
    ("[2001:db8::1]:53210", "2001:db8::1"),   # 대괄호 표기도 허용 / a bracketed form is accepted
    ("  203.0.113.7:80  ", "203.0.113.7"),
    ("203.0.113.7", "203.0.113.7"),           # 포트가 없으면 그대로 / no port, taken as-is
    ("", ""),                                 # 빈 값은 폴백을 태운다 / an empty value falls through
])
def test_viewer_ip_parsing(value, expected):
    """뷰어 주소 파싱 표 / The viewer-address parsing table."""
    assert ai.viewer_ip(value) == expected


def test_rate_limit_budget_is_shared_by_both_ai_endpoints(client, bedrock):
    """종목/기사 엔드포인트는 IP당 하나의 예산을 공유한다 / Both AI endpoints share one per-IP budget."""
    assert client.post(f"/api/ai/stocks/{SYMBOLS[0]}").status_code == 200
    assert client.post(f"/api/ai/stocks/{SYMBOLS[1]}").status_code == 200
    assert client.post("/api/ai/articles", json=ARTICLE_BODY).status_code == 200

    blocked = client.post("/api/ai/articles", json={**ARTICLE_BODY, "url": "https://example.com/news/2"})

    assert blocked.status_code == 429


# ---------------------------------------------------------------------------
# 오류 매핑 / Error mapping
# ---------------------------------------------------------------------------

def test_bedrock_unavailable_maps_to_final_503_without_leaking_the_error(client, bedrock, state):
    """가용성 실패는 final의 503 + 고정 문구, 예외 문자열(계정/ARN)은 노출하지 않는다 / Unavailable maps to a final 503 with a fixed detail; the exception text never leaks."""
    bedrock.error = bedrock_ai.BedrockUnavailableError(
        "arn:aws:bedrock:ap-northeast-2:123456789012:model/secret 접근 거부"
    )

    response = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    assert _final(response) == {"error": "ai_unavailable", "status": 503}
    assert "arn:aws" not in response.text and "123456789012" not in response.text
    # 실패는 캐시되지 않고 소스 상태에 반영된다 / The failure is not cached and is reflected in source status
    assert state.cache.l1.get(f"ai:stock:{US_SYMBOL}") is None
    assert client.get("/api/health").json()["sources"]["bedrock"] == "degraded"


def test_bedrock_call_error_maps_to_final_500_without_leaking_the_error(client, bedrock):
    """호출/입력 실패는 final의 500 + 고정 문구 / A call or input failure maps to a final 500 with a fixed detail."""
    bedrock.error = bedrock_ai.BedrockCallError("ValidationException: modelId=secret-model")

    response = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    assert _final(response) == {"error": "ai_failed", "status": 500}
    assert "secret-model" not in response.text


def test_midstream_error_still_emits_final_with_error(client, bedrock, state):
    """
    델타 일부를 낸 뒤 실패해도 final은 나간다 / A failure after partial deltas still ends with a final.

    SSE의 최다 운영 이슈(연결만 끊겨 클라이언트가 완료/사망을 구분할 수 없음)를 막는 계약이다.
    This is the contract that prevents the classic SSE failure mode: a bare connection close leaves the
    client unable to tell completion from death.
    """
    bedrock.stream_error = RuntimeError("stream died mid-flight")

    response = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    events = _events(response)
    assert _deltas(events) == STOCK_DELTAS[:1]      # 일부 델타는 이미 전달됐다 / partial deltas arrived
    assert _final(response) == {"error": "ai_failed", "status": 500}
    # 절반짜리 분석은 캐시되지 않는다 / a half-finished analysis is never cached
    assert state.cache.l1.get(f"ai:stock:{US_SYMBOL}") is None
    assert client.get("/api/health").json()["sources"]["bedrock"] == "degraded"


# ---------------------------------------------------------------------------
# 기사 분석 / Article analysis
# ---------------------------------------------------------------------------

def test_article_stream_starts_with_fetching_phase(client, bedrock):
    """
    기사 스트림의 첫 이벤트는 fetching, 본문 확보 후 analyzing / The article stream opens with fetching, then analyzing once the body is in.

    본문 조회가 분석 앞에 있다는 사실을 사용자에게 그대로 보여 준다 (주식 라우트는 analyzing부터).
    The fetch that precedes the analysis is visible as its own phase (the stock route starts at analyzing).
    """
    response = client.post("/api/ai/articles", json=ARTICLE_BODY)

    events = _events(response)
    assert events[0] == ("phase", {"phase": "fetching"})
    assert _phases(events) == ["fetching", "analyzing"]
    assert _deltas(events) == ARTICLE_DELTAS
    assert _final(response)["data"]["analysis"] == ARTICLE_ANALYSIS


def test_article_analysis_uses_fetched_content_and_url_hashed_cache_key(client, bedrock, state):
    """기사 분석은 추출한 본문으로 호출되고 sha1(url) 키로 캐시된다 / The article analysis uses the extracted body and caches under the sha1(url) key."""
    response = client.post("/api/ai/articles", json=ARTICLE_BODY)

    body = _final(response)
    assert ENVELOPE_KEYS <= set(body)
    assert body["data"]["analysis"] == ARTICLE_ANALYSIS
    assert body["data"]["url"] == ARTICLE_URL
    assert bedrock.fetched_urls == [ARTICLE_URL]
    assert bedrock.article_calls == [(ARTICLE_BODY["title"], ARTICLE_CONTENT, True)]
    assert state.cache.l1.get(ARTICLE_KEY) is not None

    # 같은 URL 재요청은 캐시 히트 (Bedrock/기사조회 모두 재호출 없음)
    # A repeat request for the same URL is a cache hit (neither Bedrock nor the article fetch runs again)
    assert _names(_events(client.post("/api/ai/articles", json=ARTICLE_BODY))) == ["phase", "final"]
    assert len(bedrock.article_calls) == 1
    assert len(bedrock.fetched_urls) == 1


def test_english_article_is_analyzed_with_translation_flag(client, bedrock):
    """language=en은 is_korean=False로 전달된다 (번역 프롬프트) / language=en passes is_korean=False (translation prompt)."""
    response = client.post("/api/ai/articles", json={**ARTICLE_BODY, "language": "en"})

    assert _final(response)["data"]["language"] == "en"
    assert bedrock.article_calls[0][2] is False


def test_article_unavailable_maps_to_final_502_and_skips_bedrock(client, bedrock, state):
    """본문 추출 실패는 final의 502이며 Bedrock을 호출하지 않는다 / A failed extraction is a final 502 and never calls Bedrock."""
    bedrock.content = ""

    response = client.post("/api/ai/articles", json=ARTICLE_BODY)

    events = _events(response)
    assert _phases(events) == ["fetching"]      # analyzing까지 가지 않았다 / it never reached analyzing
    assert _deltas(events) == []
    assert _final(response) == {"error": "article_unavailable", "status": 502}
    assert not bedrock.article_calls
    assert state.cache.l1.get(ARTICLE_KEY) is None


def test_article_requests_retain_nothing_per_url(client, bedrock, state):
    """
    기사 캐시 키는 클라이언트 URL에서 나오므로 URL당 영구 잔존물이 없어야 한다.
    Article cache keys come from client URLs, so nothing may be retained per URL.

    성공은 분석 하나(TTL 만료 후 회수)만 남기고, 실패(502)는 아무것도 남기지 않는다.
    A success leaves only its analysis (reclaimed once the TTL elapses); a 502 leaves nothing.
    """
    assert ENVELOPE_KEYS <= set(_final(client.post("/api/ai/articles", json=ARTICLE_BODY)))
    bedrock.content = ""
    rejected = client.post("/api/ai/articles", json={**ARTICLE_BODY, "url": "https://example.com/news/2"})

    assert _final(rejected) == {"error": "article_unavailable", "status": 502}
    # 키별 락은 조회 중에만 존재한다 (URL마다 락이 쌓이면 무한 증가) / A key lock lives only during a fetch
    assert state.cache._locks == {}
    # 진행 중 스트림 레지스트리도 URL당 잔존물을 남기지 않는다 (성공·실패 모두 finally에서 제거)
    # The in-flight stream registry retains nothing per URL either: both paths pop it in a finally
    assert client.app.state.ai_inflight == {}
    assert list(state.cache.l1.store) == [ARTICLE_KEY]


def test_article_body_is_validated(client, bedrock):
    """url 누락/미지원 language는 422 / A missing url or unsupported language is 422."""
    assert client.post("/api/ai/articles", json={"title": "t", "language": "ko"}).status_code == 422
    assert client.post("/api/ai/articles", json={**ARTICLE_BODY, "language": "jp"}).status_code == 422
    assert not bedrock.article_calls


# ---------------------------------------------------------------------------
# 전역 동시 실행 / Global concurrency
# ---------------------------------------------------------------------------

async def test_global_concurrency_caps_parallel_bedrock_calls(state, services, bedrock):
    """동시 요청이 많아도 Bedrock 동시 호출은 AI_GLOBAL_CONCURRENCY 이하 / Parallel Bedrock calls never exceed AI_GLOBAL_CONCURRENCY."""
    bedrock.delay = 0.05
    symbols = SYMBOLS[: config.AI_GLOBAL_CONCURRENCY + 2]
    app = create_app(state)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        responses = await asyncio.gather(*[
            # IP마다 예산이 따로이므로 동시 요청이 레이트리밋에 걸리지 않는다
            # Each IP has its own budget, so the parallel requests are not rate limited
            async_client.post(f"/api/ai/stocks/{symbol}", headers={"X-Forwarded-For": f"10.1.1.{index}"})
            for index, symbol in enumerate(symbols)
        ])

    assert [set(_final(response)) for response in responses] == [ENVELOPE_KEYS] * len(symbols)
    assert len(bedrock.stock_calls) == len(symbols)
    # 세마포어는 스트림 완료까지 보유된다 - 델타 사이에도 상한이 유지된다
    # The semaphore is held until the stream completes, so the cap holds between deltas too
    assert 1 <= bedrock.max_in_flight <= config.AI_GLOBAL_CONCURRENCY


async def test_leader_waiting_for_a_bedrock_permit_heartbeats_before_analyzing(
    state, services, bedrock, monkeypatch,
):
    """
    permit을 기다리는 **선점자**도 waiting 하트비트를 낸다 / A leader waiting for a permit heartbeats too.

    상한이 AI_GLOBAL_CONCURRENCY(2)이므로 세 번째 키는 앞선 두 스트림이 끝날 때까지 기다린다.
    그 대기가 조용하면 첫 phase 뒤로 아무 바이트도 나가지 않아 CloudFront origin-response 타임아웃에
    걸린다 - 이 기능이 없애려는 바로 그 wall-clock 제약이다. 팔로워(같은 키)만 하트비트를 내면
    서로 다른 키의 대기는 여전히 침묵한다.
    The cap is AI_GLOBAL_CONCURRENCY (2), so a third key waits for the two in-flight streams to finish. A
    silent wait sends no bytes after the first phase event and runs into the CloudFront origin-response
    timeout - the very wall-clock ceiling this feature exists to remove. Heartbeating followers alone is
    not enough: waits on *distinct* keys would stay silent.

    analyzing은 permit을 든 뒤에 (다시) 알린다 - phase 시퀀스가 사실과 어긋나면 안 된다.
    `analyzing` is (re-)announced only once the permit is held, so the phase sequence never lies.
    """
    monkeypatch.setattr(ai, "HEARTBEAT_SECONDS", 0.01)
    bedrock.delay = 0.05      # 스트림 하나가 하트비트 여러 번보다 오래 permit을 잡는다 / one stream outlasts several beats
    symbols = SYMBOLS[: config.AI_GLOBAL_CONCURRENCY + 1]
    app = create_app(state)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        responses = await asyncio.gather(*[
            # 서로 다른 심볼 = 서로 다른 캐시 키 -> 전원이 선점자다 (팔로워 경로가 아니다)
            # Distinct symbols mean distinct cache keys, so every request is a leader, not a follower
            async_client.post(f"/api/ai/stocks/{symbol}", headers={"X-Forwarded-For": f"10.7.7.{index}"})
            for index, symbol in enumerate(symbols)
        ])
        # permit 누수 확인: 뒤이은 요청이 그대로 완료된다 / no leaked permit: a later request still completes
        later = await async_client.post(
            f"/api/ai/stocks/{SYMBOLS[-1]}", headers={"X-Forwarded-For": "10.7.7.9"},
        )

    assert set(_final(later)) == ENVELOPE_KEYS
    assert len(bedrock.stock_calls) == len(symbols) + 1
    # permit이 전량 반납됐다 (대기 경로가 permit을 새지 않는다) / every permit is back: the wait leaks none
    assert app.state.ai_semaphore._value == config.AI_GLOBAL_CONCURRENCY

    waited = 0
    for response in responses:
        events = _events(response)
        assert set(_final(response)) == ENVELOPE_KEYS
        waits = [index for index, (name, data) in enumerate(events)
                 if name == "phase" and data["phase"] == "waiting"]
        if not waits:
            continue
        waited += 1
        analyzing = [index for index, (name, data) in enumerate(events)
                     if name == "phase" and data["phase"] == "analyzing"]
        first_delta = min(index for index, (name, _data) in enumerate(events) if name == "delta")
        # 대기는 델타보다 앞이고, 대기가 끝난 뒤 analyzing이 다시 나온다
        # The waits precede every delta, and `analyzing` is announced again once the wait ends
        assert max(waits) < first_delta
        assert max(analyzing) > max(waits), f"analyzing not re-announced after the wait: {_phases(events)}"
    assert waited >= 1, "permit 대기가 조용했다 / the permit wait was silent"


async def test_abandoned_permit_wait_neither_leaks_nor_double_returns_a_permit(state, monkeypatch):
    """
    대기 중 소비자가 떠나도 permit은 정확히 한 번만 정산된다 / An abandoned permit wait settles it exactly once.

    하트비트를 내려면 획득을 태스크로 띄워야 하고(`async with` 불가), 그 태스크는 소비자 이탈 시
    누구도 회수하지 않는다. permit을 흘리면 상한이 영구히 줄어들고(2 -> 1 -> 0: AI 기능 정지),
    이중 반납하면 상한이 늘어나 비용 방어가 뚫린다. 둘 다 막는다.
    Heartbeating requires acquisition to run as a task (no `async with`), and nobody harvests that task
    when the consumer leaves. Leaking the permit shrinks the cap for good (2 -> 1 -> 0 stalls the whole AI
    feature); returning it twice grows the cap and breaches the cost defense. Neither is allowed.
    """
    monkeypatch.setattr(ai, "HEARTBEAT_SECONDS", 0.01)
    semaphore = asyncio.Semaphore(1)
    await semaphore.acquire()       # 유일한 permit을 테스트가 들고 있다 / the test holds the only permit
    started: list = []

    async def never_reached() -> AsyncIterator[str]:
        started.append(1)
        yield "x"

    stream = ai._bedrock_deltas(state, semaphore, never_reached, analyzing_announced=False)

    # permit이 없으니 첫 이벤트는 대기 하트비트다 / with no permit free the first event is the wait heartbeat
    assert await stream.__anext__() == ("phase", {"phase": "waiting"})
    await stream.aclose()           # 소비자 이탈 (연결 끊김) / the consumer leaves (connection dropped)
    semaphore.release()             # 테스트가 든 permit 반납 / the test returns its own permit
    await asyncio.sleep(0.02)       # 취소가 전달될 시간 / let the cancellation land

    assert not started, "permit 없이 Bedrock 스트림을 시작했다 / the stream started without a permit"
    assert semaphore._value == 1, f"permit 정산 오류 / permit accounting is off: {semaphore._value}"


async def test_article_fetch_is_capped_by_the_global_semaphore(state, bedrock):
    """
    기사 본문 fetch도 전역 동시 실행 상한 안에서 돈다 / Article fetches run inside the global concurrency cap.

    2026-08-03 보안 리뷰 F2: 기사 캡 상향(2MB) 후 fetch 한 건이 수 MB 버퍼를 잡는다. 세마포어가
    Bedrock 호출만 묶으면, IP를 바꿔 도는 공격자가 동시 fetch 버퍼를 상한 없이 쌓을 수 있다
    (레이트리밋은 IP별·in-flight 미계수). 그래서 fetch도 같은 전역 세마포어 안으로 들어간다.
    Security review F2 (2026-08-03): after the 2MB cap raise one fetch holds multi-MB buffers. With the
    semaphore bounding only Bedrock, an attacker rotating IPs could stack unbounded concurrent fetch
    buffers (the rate limit is per-IP and counts requests, not in-flight work) — so the fetch now runs
    inside the same global semaphore.
    """
    bedrock.fetch_delay = 0.05
    total = config.AI_GLOBAL_CONCURRENCY + 2
    app = create_app(state)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        responses = await asyncio.gather(*[
            async_client.post(
                "/api/ai/articles",
                json={"url": f"https://example.com/a/{index}", "title": "t", "language": "en"},
                headers={"X-Forwarded-For": f"10.3.3.{index}"},
            )
            for index in range(total)
        ])

    assert [set(_final(response)) for response in responses] == [ENVELOPE_KEYS] * total
    assert 1 <= bedrock.max_fetch_in_flight <= config.AI_FETCH_CONCURRENCY


async def test_slow_article_fetches_do_not_starve_stock_analysis(state, services, bedrock):
    """
    느린 기사 fetch가 종목 분석의 Bedrock 예산을 잠식하지 않는다 / Slow article fetches never eat the stock-analysis budget.

    2026-08-03 보안 리뷰 재검증 breakage 1: fetch와 Bedrock이 같은 세마포어를 쓰면, trickle 오리진
    URL 2건(IP 2개 × 3회/분 × ~20s 점유)만으로 모든 사용자의 종목·기사 분석이 영구 대기한다.
    fetch는 전용 세마포어(AI_FETCH_CONCURRENCY)로 분리되어야 한다.
    Security re-review breakage 1 (2026-08-03): with fetch and Bedrock sharing one semaphore, two
    trickle-origin URLs (2 IPs × 3/min × ~20s hold) starve every user's stock and article analysis.
    The fetch must sit under its own semaphore (AI_FETCH_CONCURRENCY).
    """
    bedrock.fetch_delay = 0.5
    app = create_app(state)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        # 느린 fetch 2건으로 fetch 세마포어를 가득 채운다 / Fill the fetch semaphore with two slow fetches
        article_tasks = [
            asyncio.create_task(async_client.post(
                "/api/ai/articles",
                json={"url": f"https://example.com/slow/{index}", "title": "t", "language": "en"},
                headers={"X-Forwarded-For": f"10.4.4.{index}"},
            ))
            for index in range(config.AI_FETCH_CONCURRENCY)
        ]
        await asyncio.sleep(0.05)   # fetch들이 permit을 잡을 시간 / let the fetches acquire their permits
        assert bedrock.fetch_in_flight == config.AI_FETCH_CONCURRENCY

        started = time.perf_counter()
        stock_response = await async_client.post(
            "/api/ai/stocks/AAPL", headers={"X-Forwarded-For": "10.4.5.1"},
        )
        stock_elapsed = time.perf_counter() - started

        article_responses = await asyncio.gather(*article_tasks)

    assert set(_final(stock_response)) == ENVELOPE_KEYS
    # fetch가 0.5s씩 점유 중이어도 종목 분석은 그 뒤에 줄 서지 않는다 (여유를 둔 0.4s 상한)
    # Even with fetches holding 0.5s each, the stock analysis never queues behind them (generous 0.4s bound)
    assert stock_elapsed < 0.4, f"stock analysis waited {stock_elapsed:.2f}s behind article fetches"
    assert [set(_final(response)) for response in article_responses] == [ENVELOPE_KEYS] * config.AI_FETCH_CONCURRENCY


async def test_leader_waiting_for_a_fetch_permit_heartbeats_before_fetching(
    state, services, bedrock, monkeypatch,
):
    """
    fetch permit을 기다리는 요청도 waiting 하트비트를 낸다 / A request queued for a fetch permit heartbeats too.

    최종 리뷰 fast-follow #1: `fetching` phase는 즉시 나가지만, 그 다음 줄의 fetch 세마포어 획득
    (`AI_FETCH_CONCURRENCY`=2)은 침묵 구간이었다. 앞선 느린 fetch 2건 뒤에 줄 선 요청은 그 대기
    동안 한 바이트도 내보내지 않고, 자기 fetch가 시작된 뒤에도 최대 `FETCH_TOTAL_DEADLINE`(20s)이
    더 조용하다 - 첫 phase 뒤 침묵이 CloudFront origin-response 타임아웃을 만나는, 이 기능이
    없애려던 바로 그 구조다. Bedrock permit 대기와 **같은** 하트비트 패턴을 건다.
    Final-review fast-follow #1: the `fetching` phase leaves at once, but the very next step - acquiring
    the fetch semaphore (`AI_FETCH_CONCURRENCY` = 2) - was a silent window. A request queued behind two
    slow fetches emitted nothing while it waited, and its own fetch can then add up to
    `FETCH_TOTAL_DEADLINE` (20s) of further silence: exactly the "silence after the first phase runs into
    the CloudFront origin-response timeout" shape this feature exists to remove. So the fetch wait gets
    the **same** heartbeat pattern as the Bedrock permit wait.

    대기가 끝나면 `fetching`을 다시 알린다 - `waiting`이 마지막 phase로 남으면 프론트(latest-wins)가
    본문 조회 중을 "대기 중"으로 표시한 채 델타를 받는다.
    Once the wait ends `fetching` is re-announced: leaving `waiting` as the latest phase would have the
    frontend (latest-wins) show "queued" while the body fetch is actually running.
    """
    monkeypatch.setattr(ai, "HEARTBEAT_SECONDS", 0.01)
    bedrock.fetch_delay = 0.1    # 하트비트 여러 번보다 오래 permit을 잡는다 / one fetch outlasts several beats
    app = create_app(state)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        # 느린 fetch로 fetch 세마포어를 가득 채운다 / Fill the fetch semaphore with slow fetches
        slow = [
            asyncio.create_task(async_client.post(
                "/api/ai/articles",
                json={"url": f"https://example.com/slow/{index}", "title": "t", "language": "en"},
                headers={"X-Forwarded-For": f"10.8.8.{index}"},
            ))
            for index in range(config.AI_FETCH_CONCURRENCY)
        ]
        await asyncio.sleep(0.03)   # permit을 잡을 시간 / let them take the permits
        assert bedrock.fetch_in_flight == config.AI_FETCH_CONCURRENCY

        # 세 번째 요청: 다른 URL·다른 IP라 캐시 히트도 팔로워도 레이트리밋도 아니다 - 순수 permit 대기다
        # The third request: another URL and IP, so it is neither a cache hit, a follower nor rate limited
        queued = await async_client.post(
            "/api/ai/articles",
            json={"url": "https://example.com/queued", "title": "t", "language": "en"},
            headers={"X-Forwarded-For": "10.8.8.100"},
        )
        slow_responses = await asyncio.gather(*slow)
        # permit 누수 확인: 뒤이은 요청이 그대로 완료된다 / no leaked permit: a later request still completes
        later = await async_client.post(
            "/api/ai/articles",
            json={"url": "https://example.com/later", "title": "t", "language": "en"},
            headers={"X-Forwarded-For": "10.8.8.101"},
        )

    phases = _phases(_events(queued))
    fetching = [index for index, phase in enumerate(phases) if phase == "fetching"]
    # 대기가 있었으므로 fetching은 두 번 나온다 (즉시 + 대기 후 재알림) / two `fetching`s: immediate, then re-announced
    assert len(fetching) == 2, f"fetching not re-announced after the wait: {phases}"
    # **fetch 작업 전에** 하트비트가 있어야 한다 (침묵 구간이 사라졌다는 증거)
    # A heartbeat must precede the fetch work itself: the proof the silent window is gone
    assert "waiting" in phases[fetching[0] + 1:fetching[1]], f"the fetch permit wait was silent: {phases}"
    assert set(_final(queued)) == ENVELOPE_KEYS
    assert _deltas(_events(queued)) == ARTICLE_DELTAS

    # 대기 경로가 permit을 새지도, 이중 반납하지도 않는다 / the wait neither leaks nor double-returns a permit
    assert set(_final(later)) == ENVELOPE_KEYS
    assert app.state.ai_fetch_semaphore._value == config.AI_FETCH_CONCURRENCY
    assert [set(_final(response)) for response in slow_responses] == [ENVELOPE_KEYS] * len(slow)


async def _post_all(app, path: str, count: int, ip_prefix: str) -> list:
    """같은 경로로 동시 요청 (IP를 나눠 레이트리밋을 피한다) / Fire concurrent requests, one IP each to dodge the limit."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        return await asyncio.gather(*[
            async_client.post(path, headers={"X-Forwarded-For": f"{ip_prefix}{index}"})
            for index in range(count)
        ])


async def test_concurrent_requests_for_one_symbol_share_a_single_bedrock_call(state, services, bedrock):
    """같은 심볼 동시 요청은 Bedrock을 한 번만 호출한다 (선점자 하나 + 팔로워) / Concurrent requests for one symbol trigger a single Bedrock call (one leader, the rest follow)."""
    bedrock.delay = 0.05

    responses = await _post_all(create_app(state), f"/api/ai/stocks/{US_SYMBOL}", 3, "10.2.2.")

    finals = [_final(response) for response in responses]
    assert len(bedrock.stock_calls) == 1
    # 팔로워도 선점자와 **같은** envelope을 받는다 (asOf 포함) / followers get the leader's envelope, asOf included
    assert finals == [finals[0]] * 3
    assert set(finals[0]) == ENVELOPE_KEYS


async def test_follower_gets_waiting_heartbeat_then_final(state, services, bedrock, monkeypatch):
    """
    팔로워는 대기 중 waiting 하트비트를 받고 선점자 완료 후 final을 받는다 / A follower heartbeats `waiting`, then gets the final.

    하트비트는 CloudFront/ALB idle 카운터를 리셋하기 위한 것이다 - 없으면 느린 선점자 뒤의 팔로워가
    아무 바이트도 못 받아 연결이 끊긴다.
    The heartbeat resets the CloudFront/ALB idle counters: without it a follower behind a slow leader
    receives no bytes at all and its connection is dropped.
    """
    monkeypatch.setattr(ai, "HEARTBEAT_SECONDS", 0.01)
    bedrock.delay = 0.05        # 델타 3개 → 선점자는 하트비트 여러 번보다 오래 걸린다 / slower than several beats

    responses = await _post_all(create_app(state), f"/api/ai/stocks/{US_SYMBOL}", 2, "10.5.5.")

    assert len(bedrock.stock_calls) == 1
    waiting_counts = [_phases(_events(response)).count("waiting") for response in responses]
    assert max(waiting_counts) >= 1, f"no follower heartbeat: {waiting_counts}"
    for response in responses:
        final = _final(response)
        assert set(final) == ENVELOPE_KEYS
        assert final["data"]["analysis"] == STOCK_ANALYSIS
    # 팔로워는 델타를 받지 않는다 (선점자의 스트림은 선점자만 본다) / a follower sees no deltas
    assert sorted(len(_deltas(_events(r))) for r in responses) == [0, len(STOCK_DELTAS)]


async def test_follower_receives_the_leaders_error_as_its_own_final(state, services, bedrock, monkeypatch):
    """
    선점자가 실패하면 팔로워도 같은 오류 final을 받는다 (무한 대기 금지) / When the leader fails the follower gets the same error final, never a hang.
    """
    monkeypatch.setattr(ai, "HEARTBEAT_SECONDS", 0.01)
    bedrock.delay = 0.05
    bedrock.error = bedrock_ai.BedrockUnavailableError("no model access")

    responses = await _post_all(create_app(state), f"/api/ai/stocks/{US_SYMBOL}", 2, "10.6.6.")

    # 실패는 캐시되지 않으므로 팔로워가 선점자 결과를 그대로 물려받아야 한다 (재호출 없음)
    # The failure is not cached, so the follower must inherit the leader's outcome without a second call
    assert len(bedrock.stock_calls) == 1
    for response in responses:
        assert _final(response) == {"error": "ai_unavailable", "status": 503}


# ---------------------------------------------------------------------------
# 리미터 단위 테스트 / Limiter unit tests
# ---------------------------------------------------------------------------

class FakeClock:
    """수동으로 진행시키는 단조 시계 / A manually advanced monotonic clock."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def test_limiter_allows_up_to_the_limit_then_blocks():
    """한도까지 허용하고 그 뒤로는 차단 / Allows up to the limit, blocks afterwards."""
    limiter = SlidingWindowLimiter(3, 60)

    assert [limiter.allow("1.2.3.4") for _ in range(4)] == [True, True, True, False]


def test_limiter_tracks_each_ip_separately():
    """IP별로 독립적인 예산 / Each IP gets its own budget."""
    limiter = SlidingWindowLimiter(1, 60)

    assert limiter.allow("1.2.3.4") is True
    assert limiter.allow("5.6.7.8") is True
    assert limiter.allow("1.2.3.4") is False


def test_limiter_window_slides_and_prunes_idle_ips():
    """윈도우가 지나면 다시 허용되고 유휴 IP 항목은 정리된다 / Once the window passes requests are allowed again and idle IPs are pruned."""
    clock = FakeClock()
    limiter = SlidingWindowLimiter(1, 60, now=clock)

    assert limiter.allow("1.2.3.4") is True
    clock.now += 59
    assert limiter.allow("1.2.3.4") is False
    clock.now += 2  # 첫 요청이 윈도우를 벗어난다 / the first request leaves the window
    assert limiter.allow("1.2.3.4") is True

    clock.now += 3_600
    assert limiter.allow("5.6.7.8") is True
    # 오래된 IP 항목은 맵에서 사라진다 (무한 증가 방지) / Stale IP entries leave the map (no unbounded growth)
    assert list(limiter._hits) == ["5.6.7.8"]
