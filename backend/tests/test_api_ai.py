"""
AI 라우트 테스트 - 레이트리밋(429), 결과 캐시(Bedrock 호출 카운터), 오류 매핑(503/500/502).
AI route tests - rate limiting (429), result cache (Bedrock call counter), error mapping (503/500/502).

Bedrock은 서비스 함수(`bedrock_ai.analyze_stock`/`analyze_article`)를 monkeypatch해서 대체한다
(boto3는 건드리지 않는다). 기사 본문 조회(`news.fetch_article_content`)도 페이크다 - 네트워크 없음.
Bedrock is replaced by monkeypatching the service functions (never boto3), and the article fetch
(`news.fetch_article_content`) is faked too, so no test touches the network.
"""
from __future__ import annotations

import asyncio
import hashlib
import threading
import time

import httpx
import pytest

from app.api.ratelimit import SlidingWindowLimiter
from app.core import config
from app.main import create_app
from app.services import bedrock_ai, news
from tests.conftest import FAKE_DETAIL_PRICE, UNKNOWN_SYMBOL, US_SYMBOL

ENVELOPE_KEYS = {"asOf", "marketOpen", "data"}

STOCK_ANALYSIS = "## 기술적 분석\n상승 추세입니다."
ARTICLE_ANALYSIS = "## 요약\n실적이 좋았습니다."
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

# 한도(3)보다 많은 심볼: 캐시 히트가 아닌 진짜 200을 만들기 위해 요청마다 다른 심볼을 쓴다
# More symbols than the limit (3): each request uses its own symbol so every 200 is a real analysis
SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "META"]


class FakeBedrock:
    """호출을 기록하고 예외를 주입할 수 있는 Bedrock/기사조회 페이크 / Bedrock and article-fetch fake with call records and injectable errors."""

    def __init__(self) -> None:
        self.stock_calls: list = []
        self.article_calls: list = []
        self.fetched_urls: list = []
        self.error: Exception = None  # type: ignore[assignment]
        self.content: str = ARTICLE_CONTENT
        self.delay: float = 0.0
        # 동시 실행 관측용 / For observing concurrent execution
        self._lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0

    def _enter(self) -> None:
        with self._lock:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)

    def _exit(self) -> None:
        with self._lock:
            self.in_flight -= 1

    def analyze_stock(self, **kwargs) -> str:
        self.stock_calls.append(kwargs)
        self._enter()
        try:
            if self.delay:
                time.sleep(self.delay)
            if self.error is not None:
                raise self.error
            return STOCK_ANALYSIS
        finally:
            self._exit()

    def analyze_article(self, title: str, content: str, is_korean: bool) -> str:
        self.article_calls.append((title, content, is_korean))
        if self.error is not None:
            raise self.error
        return ARTICLE_ANALYSIS

    async def fetch_article_content(self, url: str) -> str:
        self.fetched_urls.append(url)
        return self.content


@pytest.fixture
def bedrock(monkeypatch) -> FakeBedrock:
    """Bedrock 분석 2종 + 기사 본문 조회를 페이크로 교체 / Replace both analyses and the article fetch with fakes."""
    fake = FakeBedrock()
    monkeypatch.setattr(bedrock_ai, "analyze_stock", fake.analyze_stock)
    monkeypatch.setattr(bedrock_ai, "analyze_article", fake.analyze_article)
    monkeypatch.setattr(news, "fetch_article_content", fake.fetch_article_content)
    return fake


# ---------------------------------------------------------------------------
# 종목 분석 / Stock analysis
# ---------------------------------------------------------------------------

def test_stock_analysis_returns_markdown_envelope_and_passes_cached_facts(client, bedrock, state):
    """첫 호출은 200 + 분석 텍스트이며 프롬프트 입력은 캐시된 상세/뉴스에서 온다 / First call returns the analysis; prompt inputs come from the cached detail and news."""
    response = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    assert response.status_code == 200
    body = response.json()
    assert ENVELOPE_KEYS <= set(body)
    assert body["data"] == {"symbol": US_SYMBOL, "analysis": STOCK_ANALYSIS}
    assert state.cache.l1.get(f"ai:stock:{US_SYMBOL}") is not None
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


def test_repeated_stock_analysis_is_served_from_cache_without_calling_bedrock(client, bedrock, services):
    """같은 심볼 재호출은 Bedrock을 다시 부르지 않는다 / A repeat call for the same symbol never calls Bedrock again."""
    first = client.post(f"/api/ai/stocks/{US_SYMBOL}")
    second = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    assert (first.status_code, second.status_code) == (200, 200)
    assert first.json()["data"] == second.json()["data"]
    assert len(bedrock.stock_calls) == 1
    # 상세/뉴스도 캐시에서 나온다 (AI 재호출이 업스트림을 다시 때리지 않는다)
    # The detail and news come from the cache too (a repeat AI call never re-hits upstream)
    assert services.calls["fetch_detail"] == 1
    assert services.calls["fetch_company_news"] == 1


def test_successful_analysis_marks_bedrock_source_ok(client, bedrock):
    """성공은 헬스의 bedrock 소스 상태에 반영된다 / Success is reflected in the health bedrock source status."""
    assert client.post(f"/api/ai/stocks/{US_SYMBOL}").status_code == 200

    assert client.get("/api/health").json()["sources"]["bedrock"] == "ok"


def test_unknown_symbol_is_404_and_creates_no_cache_key(client, bedrock, state):
    """유니버스 밖 심볼은 404이며 캐시 키를 만들지 않는다 / An off-universe symbol is 404 and creates no cache key."""
    assert client.post(f"/api/ai/stocks/{UNKNOWN_SYMBOL}").status_code == 404

    assert not bedrock.stock_calls
    assert not [key for key in state.cache.l1.store if UNKNOWN_SYMBOL in key]


# ---------------------------------------------------------------------------
# 레이트리밋 / Rate limiting
# ---------------------------------------------------------------------------

def test_fourth_request_from_the_same_ip_is_rate_limited(client, bedrock):
    """같은 IP의 4번째 요청은 429 + 고정 본문 / The fourth request from one IP is 429 with the fixed body."""
    for symbol in SYMBOLS[:config.AI_RATE_PER_MIN]:
        assert client.post(f"/api/ai/stocks/{symbol}").status_code == 200

    blocked = client.post(f"/api/ai/stocks/{SYMBOLS[config.AI_RATE_PER_MIN]}")

    assert blocked.status_code == 429
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


def test_rate_limit_keys_on_the_first_forwarded_ip(client, bedrock):
    """X-Forwarded-For 첫 항목이 제한 기준이다 / The first X-Forwarded-For entry is the limiter key."""
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

def test_bedrock_unavailable_maps_to_503_without_leaking_the_error(client, bedrock, state):
    """가용성 실패는 503 + 고정 문구, 예외 문자열(계정/ARN)은 노출하지 않는다 / Unavailable maps to 503 with a fixed detail; the exception text never leaks."""
    bedrock.error = bedrock_ai.BedrockUnavailableError(
        "arn:aws:bedrock:ap-northeast-2:123456789012:model/secret 접근 거부"
    )

    response = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    assert response.status_code == 503
    assert response.json() == {"detail": "ai_unavailable"}
    assert "arn:aws" not in response.text and "123456789012" not in response.text
    # 실패는 캐시되지 않고 소스 상태에 반영된다 / The failure is not cached and is reflected in source status
    assert state.cache.l1.get(f"ai:stock:{US_SYMBOL}") is None
    assert client.get("/api/health").json()["sources"]["bedrock"] == "degraded"


def test_bedrock_call_error_maps_to_500_without_leaking_the_error(client, bedrock):
    """호출/입력 실패는 500 + 고정 문구 / A call or input failure maps to 500 with a fixed detail."""
    bedrock.error = bedrock_ai.BedrockCallError("ValidationException: modelId=secret-model")

    response = client.post(f"/api/ai/stocks/{US_SYMBOL}")

    assert response.status_code == 500
    assert response.json() == {"detail": "ai_failed"}
    assert "secret-model" not in response.text


# ---------------------------------------------------------------------------
# 기사 분석 / Article analysis
# ---------------------------------------------------------------------------

def test_article_analysis_uses_fetched_content_and_url_hashed_cache_key(client, bedrock, state):
    """기사 분석은 추출한 본문으로 호출되고 sha1(url) 키로 캐시된다 / The article analysis uses the extracted body and caches under the sha1(url) key."""
    response = client.post("/api/ai/articles", json=ARTICLE_BODY)

    assert response.status_code == 200
    body = response.json()
    assert ENVELOPE_KEYS <= set(body)
    assert body["data"]["analysis"] == ARTICLE_ANALYSIS
    assert body["data"]["url"] == ARTICLE_URL
    assert bedrock.fetched_urls == [ARTICLE_URL]
    assert bedrock.article_calls == [(ARTICLE_BODY["title"], ARTICLE_CONTENT, True)]
    assert state.cache.l1.get(ARTICLE_KEY) is not None

    # 같은 URL 재요청은 캐시 히트 (Bedrock/기사조회 모두 재호출 없음)
    # A repeat request for the same URL is a cache hit (neither Bedrock nor the article fetch runs again)
    assert client.post("/api/ai/articles", json=ARTICLE_BODY).status_code == 200
    assert len(bedrock.article_calls) == 1
    assert len(bedrock.fetched_urls) == 1


def test_english_article_is_analyzed_with_translation_flag(client, bedrock):
    """language=en은 is_korean=False로 전달된다 (번역 프롬프트) / language=en passes is_korean=False (translation prompt)."""
    response = client.post("/api/ai/articles", json={**ARTICLE_BODY, "language": "en"})

    assert response.status_code == 200
    assert bedrock.article_calls[0][2] is False


def test_article_without_extractable_body_is_502_and_skips_bedrock(client, bedrock, state):
    """본문 추출 실패는 502이며 Bedrock을 호출하지 않는다 / A failed extraction is 502 and never calls Bedrock."""
    bedrock.content = ""

    response = client.post("/api/ai/articles", json=ARTICLE_BODY)

    assert response.status_code == 502
    assert response.json() == {"detail": "article_unavailable"}
    assert not bedrock.article_calls
    assert state.cache.l1.get(ARTICLE_KEY) is None


def test_article_requests_retain_nothing_per_url(client, bedrock, state):
    """
    기사 캐시 키는 클라이언트 URL에서 나오므로 URL당 영구 잔존물이 없어야 한다.
    Article cache keys come from client URLs, so nothing may be retained per URL.

    성공은 분석 하나(TTL 만료 후 회수)만 남기고, 실패(502)는 아무것도 남기지 않는다.
    A success leaves only its analysis (reclaimed once the TTL elapses); a 502 leaves nothing.
    """
    assert client.post("/api/ai/articles", json=ARTICLE_BODY).status_code == 200
    bedrock.content = ""
    rejected = client.post("/api/ai/articles", json={**ARTICLE_BODY, "url": "https://example.com/news/2"})

    assert rejected.status_code == 502
    # 키별 락은 조회 중에만 존재한다 (URL마다 락이 쌓이면 무한 증가) / A key lock lives only during a fetch
    assert state.cache._locks == {}
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

    assert [response.status_code for response in responses] == [200] * len(symbols)
    assert len(bedrock.stock_calls) == len(symbols)
    assert 1 <= bedrock.max_in_flight <= config.AI_GLOBAL_CONCURRENCY


async def test_concurrent_requests_for_one_symbol_share_a_single_bedrock_call(state, services, bedrock):
    """같은 심볼 동시 요청은 Bedrock을 한 번만 호출한다 (키별 단일 실행) / Concurrent requests for one symbol trigger a single Bedrock call (per-key single flight)."""
    bedrock.delay = 0.05
    app = create_app(state)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        responses = await asyncio.gather(*[
            async_client.post(f"/api/ai/stocks/{US_SYMBOL}", headers={"X-Forwarded-For": f"10.2.2.{index}"})
            for index in range(3)
        ])

    assert [response.status_code for response in responses] == [200, 200, 200]
    assert len(bedrock.stock_calls) == 1


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
