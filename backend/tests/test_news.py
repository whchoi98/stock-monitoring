"""
뉴스 서비스 테스트 - 고정 RSS/HTML 문자열 + `httpx.MockTransport` (실제 네트워크 호출 없음)
News service tests - fixed RSS/HTML strings served through `httpx.MockTransport` (no real network calls).

**시임(seam)은 트랜스포트다 - `AsyncClient.get`이 아니다.** 클라이언트 메서드를 가로채면 httpx의
리다이렉트 처리기가 실행되지 않으므로, `follow_redirects=False`를 `True`로 바꿔도 테스트가 전부
통과해버린다 (홉별 SSRF 재검증이 테스트에 보이지 않는다). 트랜스포트를 대체하면 요청 생성·리다이렉트·
스트리밍·콘텐츠 디코딩이 모두 실제 코드로 실행되고, 리다이렉트 대상도 트랜스포트를 통과하므로
"내부망으로 유도하는 리다이렉트"를 진짜로 관측할 수 있다.
**The seam is the transport, not `AsyncClient.get`.** Patching the client method skips httpx's redirect
machinery, so flipping `follow_redirects=False` to `True` would leave every test green while the per-hop
SSRF re-validation silently stops running. Replacing the transport keeps request building, redirects,
streaming and content decoding on the real code path, and a redirect target really does reach the
transport, which is what makes "a redirect toward the internal network" observable.
"""
import gzip
import hashlib
import json
import logging
import socket
import threading
import time

import httpx
import pytest

from app.core import config
from app.services import news
from app.services.news import parse_rss

LOGGER_NAME = "app.services.news"


# ---------------------------------------------------------------------------
# 네트워크 차단 / Network guard
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _block_network(monkeypatch):
    """
    소켓 연결을 차단해 네트워크 호출을 원천 봉쇄 / Block socket connects so no test can reach the network.

    socket 생성 자체는 막지 않는다 (asyncio 이벤트 루프의 self-pipe가 필요하다).
    Socket creation itself stays allowed: the asyncio event loop needs it for its self-pipe.
    """
    def guard(*args, **kwargs):
        raise AssertionError("real network access is not allowed in tests")

    monkeypatch.setattr(socket.socket, "connect", guard)
    monkeypatch.setattr(socket.socket, "connect_ex", guard)
    monkeypatch.setattr(socket, "getaddrinfo", guard)


# ---------------------------------------------------------------------------
# 고정 픽스처 / Fixed fixtures
# ---------------------------------------------------------------------------

def _rss(*items) -> str:
    """(title, link, pub_date, description) 튜플로 RSS XML 생성 / Build RSS XML from (title, link, pub_date, description) tuples."""
    body = "".join(
        "<item>"
        f"<title>{title}</title>"
        f"<link>{link}</link>"
        f"<pubDate>{pub_date}</pubDate>"
        f"<description>{description}</description>"
        "</item>"
        for title, link, pub_date, description in items
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<rss version="2.0"><channel><title>Feed</title>'
        f"{body}"
        "</channel></rss>"
    )


def _numbered_rss(count: int, prefix: str = "Item") -> str:
    """번호가 붙은 항목 count개의 RSS / RSS carrying `count` numbered items."""
    return _rss(*[
        (f"{prefix} {i}", f"https://example.com/{prefix}/{i}", "Mon, 01 Jun 2026 09:00:00 GMT", "")
        for i in range(count)
    ])


def _resp(text: str = "", status_code: int = 200, headers=None) -> httpx.Response:
    """
    고정 본문 응답 (진짜 `httpx.Response`) / A fixed-body response (a real `httpx.Response`).

    명시한 헤더는 그대로 유지된다 (예: 거짓 `content-length`로 크기 가드를 시험한다).
    Explicit headers are preserved as given (e.g. a lying `content-length` to exercise the size guard).
    """
    return httpx.Response(status_code, text=text, headers=headers)


class _ChunkStream(httpx.AsyncByteStream):
    """
    본문을 고정 크기 청크로 흘리며 실제로 소비된 청크 수를 센다.
    Streams a body in fixed-size chunks and counts how many chunks were actually consumed.

    소비자가 상한에서 읽기를 끊었는지(= 남은 본문을 버퍼링하지 않았는지) 관측하는 유일한 방법이다.
    This is the only way to observe that the consumer stopped at the cap instead of buffering the rest.
    """

    def __init__(self, payload: bytes, chunk_size: int) -> None:
        self.payload = payload
        self.chunk_size = chunk_size
        self.chunks_pulled = 0

    @property
    def chunk_total(self) -> int:
        """전체 청크 수 (올림) / Total number of chunks (ceiling division)."""
        return -(-len(self.payload) // self.chunk_size)

    async def __aiter__(self):
        for start in range(0, len(self.payload), self.chunk_size):
            self.chunks_pulled += 1
            yield self.payload[start:start + self.chunk_size]


def _streamed(stream: _ChunkStream, headers=None, status_code: int = 200) -> httpx.Response:
    """청크 스트림을 본문으로 갖는 응답 / A response whose body is a chunked stream."""
    return httpx.Response(status_code, headers=headers, stream=stream)


def _patch_transport(monkeypatch, routes):
    """
    모든 `httpx.AsyncClient`에 URL->응답 매핑 `MockTransport`를 심고 요청을 기록.
    Give every `httpx.AsyncClient` a `MockTransport` backed by a URL->response map, recording requests.

    `_client()`가 넘기는 인자(타임아웃/헤더/`follow_redirects`)는 건드리지 않고 트랜스포트만 주입하므로,
    리다이렉트 처리와 스트리밍은 실제 httpx 코드가 수행한다.
    Only the transport is injected; the arguments `_client()` passes (timeout, headers,
    `follow_redirects`) stay untouched, so redirects and streaming run on real httpx code.

    값이 Exception이면 raise한다 (조회 실패 시나리오) / An Exception value is raised (fetch-failure scenario).
    """
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        # 요청을 먼저 기록한다: 예상 밖 URL이 구현의 `except Exception`에 삼켜져도 테스트에는 보인다
        # Record first: an unexpected URL stays visible even if the implementation swallows the error
        calls.append({
            "url": url,
            "user_agent": request.headers.get("user-agent"),
            "accept_encoding": request.headers.get("accept-encoding"),
        })
        if url not in routes:
            raise AssertionError(f"unexpected URL requested: {url}")
        outcome = routes[url]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    transport = httpx.MockTransport(handler)
    original_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):
        kwargs.setdefault("transport", transport)
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)
    return calls


PUBLIC_IP = "93.184.216.34"


def _patch_dns(monkeypatch, mapping=None, default=PUBLIC_IP):
    """
    `socket.getaddrinfo`를 호스트->주소 매핑으로 대체 (DNS 조회 없음) / Replace `socket.getaddrinfo` with a host->address map (no DNS).

    값이 Exception이면 raise한다 (해석 실패 시나리오) / An Exception value is raised (resolution-failure scenario).
    autouse 가드가 이미 getaddrinfo를 막아두므로, 이 스텁이 그 위에 덮인다.
    The autouse guard already blocks getaddrinfo; this stub layers on top of it.
    """
    lookups = []

    def fake_getaddrinfo(host, port=None, *args, **kwargs):
        lookups.append(host)
        outcome = (mapping or {}).get(host, default)
        if isinstance(outcome, Exception):
            raise outcome
        addresses = [outcome] if isinstance(outcome, str) else list(outcome)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (addr, 0)) for addr in addresses]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    return lookups


def _warning_payloads(caplog):
    """경고 로그가 모두 단일 라인 JSON임을 확인하고 파싱 / Assert single-line JSON warnings and parse them."""
    payloads = []
    for record in caplog.records:
        message = record.getMessage()
        assert "\n" not in message  # 단일 라인 JSON / single-line JSON
        payloads.append(json.loads(message))
    return payloads


def _sha1_16(link: str) -> str:
    return hashlib.sha1(link.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# parse_rss
# ---------------------------------------------------------------------------

def test_parse_rss_field_mapping():
    """RSS 필드가 NewsItem 필드로 그대로 매핑된다 / RSS fields map straight onto NewsItem fields."""
    xml_text = _rss(
        ("Stocks rally on Fed news", "https://example.com/a", "Mon, 01 Jun 2026 09:30:00 GMT",
         "&lt;p&gt;Wall Street gained&lt;/p&gt;"),
    )

    items = parse_rss(xml_text, "Yahoo", is_korean=False)

    assert len(items) == 1
    item = items[0]
    assert item.title == "Stocks rally on Fed news"   # 원문 유지 (번역/접두사 없음) / original title, no translation or prefix
    assert item.link == "https://example.com/a"
    assert item.source == "Yahoo"
    assert item.published == "Mon, 01 Jun 2026 09:30:00 GMT"   # 원본 pubDate 문자열 / raw pubDate string
    assert item.language == "en"
    assert item.id == _sha1_16("https://example.com/a")
    assert len(item.id) == 16


def test_parse_rss_korean_source_sets_ko_language():
    """is_korean=True면 language가 'ko' / is_korean=True yields language 'ko'."""
    items = parse_rss(_rss(("삼성전자 최고가", "https://hk.com/1", "", "")), "한경", is_korean=True)
    assert [(i.language, i.source) for i in items] == [("ko", "한경")]


def test_parse_rss_ids_are_link_derived_and_distinct():
    """id는 link의 sha1 앞 16자로 항목마다 달라진다 / ids are the link sha1 prefix, so they differ per item."""
    items = parse_rss(_numbered_rss(3), "Yahoo", is_korean=False)
    assert [i.id for i in items] == [_sha1_16(i.link) for i in items]
    assert len(set(i.id for i in items)) == 3


def test_parse_rss_skips_items_without_title():
    """title이 없는 항목은 건너뛴다 / Items without a title are skipped."""
    xml_text = _rss(
        ("", "https://example.com/none", "Mon, 01 Jun 2026 09:00:00 GMT", ""),
        ("Kept", "https://example.com/kept", "Mon, 01 Jun 2026 09:00:00 GMT", ""),
    )
    assert [i.title for i in parse_rss(xml_text, "Yahoo", is_korean=False)] == ["Kept"]


def test_parse_rss_missing_pub_date_is_empty_string():
    """pubDate가 없으면 published는 빈 문자열 / A missing pubDate leaves published empty."""
    xml_text = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<rss version="2.0"><channel>'
        "<item><title>No date</title><link>https://example.com/x</link></item>"
        "</channel></rss>"
    )
    items = parse_rss(xml_text, "Yahoo", is_korean=False)
    assert [(i.published, i.title) for i in items] == [("", "No date")]


def test_parse_rss_empty_feed_returns_empty_list():
    assert parse_rss(_rss(), "Yahoo", is_korean=False) == []


def test_parse_rss_invalid_xml_warns_and_returns_empty(caplog):
    """깨진 XML은 조용히 넘기지 않고 경고 후 빈 리스트 / Broken XML warns (no silent failure) and returns an empty list."""
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert parse_rss("<rss><channel><item>", "Yahoo", is_korean=False) == []

    payloads = _warning_payloads(caplog)
    assert any(p.get("source") == "Yahoo" for p in payloads)
    assert any(p.get("error_type") == "ParseError" for p in payloads)


def test_parse_rss_accepts_plain_doctype():
    """엔티티 없는 DOCTYPE은 정상 파싱 (실피드 호환) / A DOCTYPE without entities still parses (real-feed compatibility)."""
    xml_text = (
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE rss>'
        '<rss version="2.0"><channel>'
        "<item><title>Kept</title><link>https://example.com/d</link></item>"
        "</channel></rss>"
    )
    assert [i.title for i in parse_rss(xml_text, "Yahoo", is_korean=False)] == ["Kept"]


# ---------------------------------------------------------------------------
# parse_rss - 적대적 XML (원격 3rd-party 피드다) / parse_rss - hostile XML (feeds are remote and third-party)
# ---------------------------------------------------------------------------

# 엔티티 확장 폭탄 - 중첩은 3단계로 작게 유지한다 (defusedxml이 즉시 거부하므로 확장되지 않는다)
# Entity-expansion bomb - kept tiny at three levels; defusedxml refuses it before any expansion
BILLION_LAUGHS = (
    '<?xml version="1.0"?>'
    "<!DOCTYPE lolz ["
    '<!ENTITY lol "lol">'
    '<!ENTITY lol2 "&lol;&lol;&lol;">'
    '<!ENTITY lol3 "&lol2;&lol2;&lol2;">'
    "]>"
    "<rss version=\"2.0\"><channel>"
    "<item><title>&lol3;</title><link>https://example.com/bomb</link></item>"
    "</channel></rss>"
)

# 외부 엔티티 (XXE) - 로컬 파일 읽기 시도 / External entity (XXE) attempting a local file read
XXE_FEED = (
    '<?xml version="1.0"?>'
    '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
    "<rss version=\"2.0\"><channel>"
    "<item><title>&xxe;</title><link>https://example.com/xxe</link></item>"
    "</channel></rss>"
)


@pytest.mark.parametrize("payload,label", [(BILLION_LAUGHS, "bomb"), (XXE_FEED, "xxe")])
def test_parse_rss_rejects_hostile_entities(caplog, payload, label):
    """
    엔티티 폭탄/XXE는 확장 없이 즉시 거부 + 경고 / Entity bombs and XXE are refused immediately, with a warning.

    예외를 전파하지 않으므로 적대적 피드 하나가 워커를 죽이지 못한다.
    No exception propagates, so a single hostile feed cannot take down the worker.
    """
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert parse_rss(payload, "Yahoo", is_korean=False) == []

    payloads = _warning_payloads(caplog)
    # defusedxml 계열 예외로 거부되었음을 명시 (ParseError가 아니다)
    # Explicitly a defusedxml-family rejection, not a ParseError
    assert any(p.get("error_type") == "EntitiesForbidden" and p.get("source") == "Yahoo"
               for p in payloads), payloads


def test_parse_rss_does_not_read_local_files_for_xxe(caplog):
    """XXE 페이로드가 로컬 파일 내용을 항목으로 흘리지 않는다 / An XXE payload never leaks local file content into items."""
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        items = parse_rss(XXE_FEED, "Yahoo", is_korean=False)

    assert items == []
    assert "root:" not in caplog.text   # /etc/passwd 내용이 로그로도 새지 않는다 / no passwd content leaks into logs


async def test_fetch_news_skips_hostile_feed_and_keeps_others(monkeypatch, caplog):
    """적대적 피드는 skip하고 나머지 소스는 유지 / A hostile feed is skipped while the other sources survive."""
    routes = {url: _resp(_numbered_rss(2, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    routes[config.NEWS_FEEDS["yahoo"]] = _resp(BILLION_LAUGHS)
    _patch_transport(monkeypatch, routes)

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        items = await news.fetch_news()

    assert len(items) == 6
    # 제목 첫 토큰이 소스 키다 ("yahoo_markets"는 살아남아야 하므로 정확히 비교) / the first title token is the source key
    assert {i.title.split()[0] for i in items} == {"yahoo_markets", "hankyung", "mk"}
    assert any(p.get("error_type") == "EntitiesForbidden" for p in _warning_payloads(caplog))


# ---------------------------------------------------------------------------
# fetch_news
# ---------------------------------------------------------------------------

async def test_fetch_news_queries_every_configured_feed(monkeypatch):
    """NEWS_FEEDS 4종을 모두 조회하고 소스별 언어를 부여 / All four NEWS_FEEDS are queried, each with its own language."""
    routes = {url: _resp(_numbered_rss(2, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    calls = _patch_transport(monkeypatch, routes)

    items = await news.fetch_news()

    assert len(config.NEWS_FEEDS) == 4
    assert sorted(c["url"] for c in calls) == sorted(config.NEWS_FEEDS.values())
    assert len(items) == 8
    # 한국 소스(hankyung/mk)만 ko / Only the Korean sources (hankyung/mk) are ko
    languages = {i.title.split()[0]: i.language for i in items}
    assert languages == {"yahoo": "en", "yahoo_markets": "en", "hankyung": "ko", "mk": "ko"}


async def test_fetch_news_sends_browser_user_agent(monkeypatch):
    """TUI와 동일한 User-Agent 헤더 전송 / Sends the same User-Agent header as the TUI."""
    routes = {url: _resp(_numbered_rss(1)) for url in config.NEWS_FEEDS.values()}
    calls = _patch_transport(monkeypatch, routes)

    await news.fetch_news()

    assert calls and all(c["user_agent"] == "Mozilla/5.0 (StockMonitor/1.0)" for c in calls)


async def test_fetch_news_caps_items_per_source(monkeypatch):
    """소스당 max_per_source개까지만 반환 / At most max_per_source items come back per source."""
    routes = {url: _resp(_numbered_rss(12)) for url in config.NEWS_FEEDS.values()}
    _patch_transport(monkeypatch, routes)

    assert len(await news.fetch_news(max_per_source=3)) == 12   # 3 * 4 feeds
    assert len(await news.fetch_news()) == 40                   # 기본 10 * 4 / default 10 * 4


async def test_fetch_news_one_feed_fails_others_survive(monkeypatch, caplog):
    """피드 1개가 실패해도 나머지 3개 결과는 반환 + 경고 / One failing feed still returns the other three, with a warning."""
    routes = {url: _resp(_numbered_rss(2, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    broken_url = config.NEWS_FEEDS["hankyung"]
    routes[broken_url] = httpx.ConnectTimeout("feed boom")
    _patch_transport(monkeypatch, routes)

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        items = await news.fetch_news()

    assert len(items) == 6
    assert all(not i.title.startswith("hankyung") for i in items)
    payloads = _warning_payloads(caplog)
    assert any(p.get("url") == broken_url and "feed boom" in p.get("error", "") for p in payloads)


async def test_fetch_news_non_200_feed_is_skipped_with_warning(monkeypatch, caplog):
    """200이 아닌 피드는 skip + 경고 / A non-200 feed is skipped and warned about."""
    routes = {url: _resp(_numbered_rss(2, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    routes[config.NEWS_FEEDS["mk"]] = _resp("", status_code=503)
    _patch_transport(monkeypatch, routes)

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        items = await news.fetch_news()

    assert len(items) == 6
    payloads = _warning_payloads(caplog)
    assert any(p.get("status") == 503 for p in payloads)


# ---------------------------------------------------------------------------
# fetch_company_news
# ---------------------------------------------------------------------------

async def test_fetch_company_news_us_uses_yahoo_headline_feed(monkeypatch):
    """US 심볼은 Yahoo headline RSS / A US symbol hits the Yahoo headline RSS feed."""
    url = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL&region=US&lang=en-US"
    calls = _patch_transport(monkeypatch, {url: _resp(_numbered_rss(2))})

    items = await news.fetch_company_news("AAPL")

    assert [c["url"] for c in calls] == [url]
    assert len(items) == 2
    assert [i.language for i in items] == ["en", "en"]
    assert [i.source for i in items] == ["Yahoo", "Yahoo"]


async def test_fetch_company_news_kr_uses_google_news_with_stock_name(monkeypatch):
    """KR 심볼은 STOCK_NAMES 종목명 + '주식'으로 Google News RSS 검색 / A KR symbol searches Google News with the STOCK_NAMES name + '주식'."""
    assert config.STOCK_NAMES["005930.KS"] == "Samsung Electronics"
    url = (
        "https://news.google.com/rss/search"
        "?q=Samsung+Electronics+%EC%A3%BC%EC%8B%9D&hl=ko&gl=KR&ceid=KR:ko"
    )
    calls = _patch_transport(monkeypatch, {url: _resp(_numbered_rss(2))})

    items = await news.fetch_company_news("005930.KS")

    assert [c["url"] for c in calls] == [url]
    assert [i.language for i in items] == ["ko", "ko"]
    assert [i.source for i in items] == ["Google", "Google"]


async def test_fetch_company_news_kosdaq_suffix_also_uses_google(monkeypatch):
    """.KQ도 KR 경로 / The .KQ suffix takes the KR path as well."""
    url = (
        "https://news.google.com/rss/search"
        "?q=Ecopro+BM+%EC%A3%BC%EC%8B%9D&hl=ko&gl=KR&ceid=KR:ko"
    )
    calls = _patch_transport(monkeypatch, {url: _resp(_numbered_rss(1))})

    assert len(await news.fetch_company_news("247540.KQ")) == 1
    assert [c["url"] for c in calls] == [url]


async def test_fetch_company_news_caps_at_eight_items(monkeypatch):
    """종목 뉴스는 최대 8건 / Company news is capped at eight items."""
    url = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=MSFT&region=US&lang=en-US"
    _patch_transport(monkeypatch, {url: _resp(_numbered_rss(20))})

    assert len(await news.fetch_company_news("MSFT")) == 8


async def test_fetch_company_news_failure_returns_empty_with_warning(monkeypatch, caplog):
    """조회 실패는 경고 + 빈 리스트 / A failed fetch warns and returns an empty list."""
    url = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=TSLA&region=US&lang=en-US"
    _patch_transport(monkeypatch, {url: httpx.ConnectError("company boom")})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_company_news("TSLA") == []

    payloads = _warning_payloads(caplog)
    assert any(p.get("symbol") == "TSLA" and "company boom" in p.get("error", "") for p in payloads)


# ---------------------------------------------------------------------------
# fetch_article_content
# ---------------------------------------------------------------------------

ARTICLE_URL = "https://example.com/story/1"

# 내부망/메타데이터 주소 (SSRF 표적) / Internal and metadata addresses (SSRF targets)
INTERNAL_ADDRESSES = ["127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.1", "172.16.0.1",
                      "0.0.0.0", "224.0.0.1"]


async def test_fetch_article_content_extracts_from_article_tag(monkeypatch):
    """전략 1: <article> 안의 <p>만 추출하고 짧은 단락은 버린다 / Stage 1: only <p> inside <article>, dropping short paragraphs."""
    html = (
        "<html><body>"
        "<nav><p>Navigation paragraph that should never be picked up here</p></nav>"
        '<article class="story">'
        "<p>This first paragraph is longer than twenty characters.</p>"
        "<p>short</p>"
        "<p>Second&nbsp;paragraph <b>with</b> markup is also long enough.</p>"
        "</article>"
        "</body></html>"
    )
    _patch_dns(monkeypatch)
    _patch_transport(monkeypatch, {ARTICLE_URL: _resp(html)})

    content = await news.fetch_article_content(ARTICLE_URL)

    assert content == (
        "This first paragraph is longer than twenty characters.\n\n"
        "Second paragraph with markup is also long enough."
    )


async def test_fetch_article_content_falls_back_to_body_class(monkeypatch):
    """전략 2: <article>이 없으면 본문 CSS 클래스 div에서 추출 / Stage 2: without <article>, read the body-class div."""
    html = (
        "<html><body>"
        '<div class="wrapper newsct_article kr"><p>한국어 기사 본문 단락입니다. 충분히 깁니다.</p>'
        "<p>짧음</p><p>두 번째 단락도 스무 자를 넘기므로 유지됩니다.</p></div>"
        "</body></html>"
    )
    _patch_dns(monkeypatch)
    _patch_transport(monkeypatch, {ARTICLE_URL: _resp(html)})

    content = await news.fetch_article_content(ARTICLE_URL)

    assert content == (
        "한국어 기사 본문 단락입니다. 충분히 깁니다.\n\n"
        "두 번째 단락도 스무 자를 넘기므로 유지됩니다."
    )


async def test_fetch_article_content_falls_back_to_all_paragraphs_filtering_ads(monkeypatch):
    """전략 3: 모든 <p> 중 50자 초과 + 광고/약관 문구 제외 / Stage 3: all <p> over 50 chars, minus ad/boilerplate lines."""
    keep = "This paragraph is comfortably longer than fifty characters so it is kept."
    short = "Too short to keep even in the final fallback stage"   # 50자 경계 / exactly at the 50-char boundary
    html = (
        "<html><body>"
        f"<p>{keep}</p>"
        f"<p>{short}</p>"
        "<p>We use cookies on this site for advertising and analytics purposes here.</p>"
        "<p>Please enable JavaScript to continue reading this article on our website.</p>"
        "<p>Copyright 2026 Example Media. All rights reserved worldwide, everywhere.</p>"
        "</body></html>"
    )
    _patch_dns(monkeypatch)
    _patch_transport(monkeypatch, {ARTICLE_URL: _resp(html)})

    assert len(short) == 50
    assert await news.fetch_article_content(ARTICLE_URL) == keep


async def test_fetch_article_content_keeps_paragraphs_after_a_nested_div(monkeypatch):
    """
    전략 2는 중첩 `<div>`에서 본문을 끊지 않는다 / Stage 2 does not stop the body at a nested `<div>`.

    본문 컨테이너 안에 사진 캡션용 `<div>`가 들어가는 것은 흔한 마크업이다. 닫는 태그를 게으르게
    찾던 옛 구현은 그 첫 `</div>`에서 기사를 잘라 뒤 단락을 모두 잃었다.
    A caption `<div>` inside the body container is ordinary markup; the old lazy closing-tag search cut the
    article at that first `</div>` and lost every later paragraph.
    """
    _patch_dns(monkeypatch)
    html = (
        "<html><body>"
        '<div class="wrapper article-body">'
        "<p>First body paragraph before the nested container element.</p>"
        '<div class="photo-caption"><span>caption</span></div>'
        "<p>Second body paragraph living after the nested container.</p>"
        "</div></body></html>"
    )
    _patch_transport(monkeypatch, {ARTICLE_URL: _resp(html)})

    content = await news.fetch_article_content(ARTICLE_URL)

    assert content == (
        "First body paragraph before the nested container element.\n\n"
        "Second body paragraph living after the nested container."
    )


def _repeated_to_cap(unit: str) -> str:
    """상한(`MAX_ARTICLE_SIZE`)을 꽉 채우도록 `unit`을 반복 / Repeat `unit` to fill the cap exactly."""
    return unit * (news.MAX_ARTICLE_SIZE // len(unit))


# 닫는 짝이 없는 태그가 반복되는 형태들 - 추출 정규식이 후보 시작 위치마다 EOF까지 훑던 입력들이다.
# 각 항목: (id, 상한을 채운 입력, 수정 전 실측 초). 2026-08-02 측정, 262 144바이트(당시 상한) 기준 — 입력은 현재 상한을 채우도록 동적으로 커진다.
# Shapes that repeat an unclosed tag - the inputs that made an extraction regex rescan to EOF per
# candidate start. Each entry: (id, input filling the cap, seconds measured before the fix), taken
# 2026-08-02 at 262,144 bytes (the cap at the time); the inputs grow dynamically to fill the current cap.
UNCLOSED_TAG_SHAPES = [
    # `<div ...>` 후보 (전략 2). 앞에 `class="..."`를 붙이면 정규식이 일찍 실패해 느려지지 않으므로
    # 재현에는 순수 반복 형태를 써야 한다 / stage-2 body-class candidates. A leading `class="..."` makes the
    # regex fail early and stay fast, so the pure repeated shape is what actually reproduces it.
    ("unclosed_div_tag", _repeated_to_cap("<div "), 39.4),
    # `<p ...>` 후보 (모든 전략의 단락 스캔) / paragraph scan used by every stage
    ("unclosed_p_tag", _repeated_to_cap("<p>"), 136.1),
    # `<article ...>` 후보 (전략 1) / stage-1 article candidates
    ("unclosed_article_tag", _repeated_to_cap("<article>"), 43.4),
    # 단락 본문 안의 태그 제거 (`_clean_html`) / tag stripping inside a paragraph body (`_clean_html`)
    ("unclosed_tag_inside_paragraph", "<p>" + _repeated_to_cap("<a ")[:news.MAX_ARTICLE_SIZE - 10] + "</p>", 34.2),
]


@pytest.mark.parametrize(
    "html,seconds_before",
    [pytest.param(html, before, id=shape_id) for shape_id, html, before in UNCLOSED_TAG_SHAPES],
)
async def test_fetch_article_content_bounds_backtracking_on_unclosed_tag_shapes(
    monkeypatch, html, seconds_before,
):
    """
    닫히지 않은 태그가 반복되는 입력에서 추출이 즉시 끝난다 / Extraction finishes immediately on repeated unclosed tags.

    보장하는 것은 "모든 입력에 선형"이 아니라 **후보 시작 위치당 작업량이 상수로 묶인다**는 것이다
    (`[^<>]{0,MAX_TAG_SCAN}` + 단락 짝맞추기 1패스 + `str.find` 창). 그래서 각 형태를 개별적으로
    시간 상한으로 묶는다 - 한 형태만 재보면 다른 형태의 회귀를 놓친다.
    The guarantee is not "linear for every input" but that the work per candidate start position is
    constant-bounded (`[^<>]{0,MAX_TAG_SCAN}`, a single pairing pass for paragraphs, and a `str.find`
    window). Each shape therefore gets its own time bound: measuring one shape would miss a regression in
    another.

    수정 전 실측치는 파라미터로 들어온다 (39.4s / 136.1s / 43.4s / 34.2s @262KB). 수정 후에는 모두
    0.03초 미만이므로, 여유를 크게 둔 1초 상한이 회귀를 명확히 잡는다.
    The pre-fix measurement rides along as a parameter (39.4s / 136.1s / 43.4s / 34.2s at 262KB). After the
    fix every shape is under 0.03s, so a generous one-second bound catches a regression unambiguously.
    """
    _patch_dns(monkeypatch)
    assert len(html) >= news.MAX_ARTICLE_SIZE - 16      # 상한을 꽉 채운 입력 / the input fills the cap
    assert seconds_before > 30                          # 수정 전에는 30초를 넘었다 / it exceeded 30s before the fix
    _patch_transport(monkeypatch, {ARTICLE_URL: _resp(html)})

    started = time.perf_counter()
    content = await news.fetch_article_content(ARTICLE_URL)
    elapsed = time.perf_counter() - started

    assert elapsed < 1.0, (
        f"extraction took {elapsed:.1f}s (was {seconds_before}s before the bounds) "
        "- unbounded backtracking is back"
    )
    assert isinstance(content, str)   # 추출 실패는 ""다 (예외를 던지지 않는다) / a failed extraction is "", never a raise


async def test_fetch_article_content_still_extracts_around_a_pathological_tail(monkeypatch):
    """
    적대적 꼬리가 붙어도 앞쪽 본문은 정상 추출 / A hostile tail does not stop the real body from being extracted.

    시간 상한만 보면 "아무것도 추출하지 않는" 구현도 통과하므로, 같은 형태에 진짜 단락을 섞어
    결과까지 확인한다.
    A time bound alone would also pass for an implementation that extracts nothing, so the same shape is
    mixed with a real paragraph and the result is asserted too.
    """
    _patch_dns(monkeypatch)
    html = f'<div class="article-body"><p>{KEPT_PARAGRAPH}</p>' + '<div class="article-body">' * 8000
    _patch_transport(monkeypatch, {ARTICLE_URL: _resp(html)})

    started = time.perf_counter()
    content = await news.fetch_article_content(ARTICLE_URL)
    elapsed = time.perf_counter() - started

    assert content == KEPT_PARAGRAPH
    assert elapsed < 1.0, f"extraction took {elapsed:.1f}s"


async def test_paragraph_extraction_runs_off_the_event_loop(monkeypatch):
    """
    추출은 이벤트 루프 스레드에서 돌지 않는다 / Extraction never runs on the event-loop thread.

    CPU 바운드 정규식 스캔이므로 루프에서 돌면 그 시간 동안 다른 모든 요청이 멈춘다.
    It is a CPU-bound regex scan: on the loop it would stall every other request for its duration.
    """
    _patch_dns(monkeypatch)
    _patch_transport(monkeypatch, {
        ARTICLE_URL: _resp("<article><p>Body paragraph that is long enough to keep.</p></article>"),
    })
    loop_thread = threading.get_ident()
    seen = {}
    original = news._extract_paragraphs

    def spy(html):
        seen["thread"] = threading.get_ident()
        return original(html)

    monkeypatch.setattr(news, "_extract_paragraphs", spy)

    assert await news.fetch_article_content(ARTICLE_URL) == "Body paragraph that is long enough to keep."

    assert seen["thread"] != loop_thread


async def test_fetch_article_content_caps_at_25_paragraphs(monkeypatch):
    """최대 25개 단락까지만 결합 / At most 25 paragraphs are joined."""
    paras = "".join(f"<p>Paragraph number {i} is long enough to be kept.</p>" for i in range(40))
    _patch_dns(monkeypatch)
    _patch_transport(monkeypatch, {ARTICLE_URL: _resp(f"<article>{paras}</article>")})

    content = await news.fetch_article_content(ARTICLE_URL)

    parts = content.split("\n\n")
    assert len(parts) == 25
    assert parts[0].startswith("Paragraph number 0")
    assert parts[-1].startswith("Paragraph number 24")


async def test_fetch_article_content_returns_empty_on_fetch_failure(monkeypatch, caplog):
    """조회 실패는 경고 + 빈 문자열 (라우트가 사용자 오류로 변환) / A failed fetch warns and returns "" (the route surfaces the error)."""
    _patch_dns(monkeypatch)
    _patch_transport(monkeypatch, {ARTICLE_URL: httpx.ReadTimeout("article boom")})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    payloads = _warning_payloads(caplog)
    assert any(p.get("url") == ARTICLE_URL and "article boom" in p.get("error", "") for p in payloads)


async def test_fetch_article_content_returns_empty_on_non_200(monkeypatch, caplog):
    """200이 아니면 경고 + 빈 문자열 / A non-200 status warns and returns ""."""
    _patch_dns(monkeypatch)
    _patch_transport(monkeypatch, {ARTICLE_URL: _resp("<article><p>hidden</p></article>", status_code=403)})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    assert any(p.get("status") == 403 for p in _warning_payloads(caplog))


async def test_fetch_article_content_returns_empty_when_nothing_extractable(monkeypatch, caplog):
    """추출 실패도 조용히 넘기지 않는다 / An unextractable page warns instead of failing silently."""
    _patch_dns(monkeypatch)
    _patch_transport(monkeypatch, {ARTICLE_URL: _resp("<html><body><div>no paragraphs</div></body></html>")})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    assert any(p.get("url") == ARTICLE_URL for p in _warning_payloads(caplog))


# ---------------------------------------------------------------------------
# fetch_article_content - SSRF / 크기 가드 (URL이 클라이언트 입력이다)
# fetch_article_content - SSRF and size guards (the URL is client input)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "ftp://example.com/secret.txt",
    "gopher://example.com/",
    "http+unix://%2Fvar%2Frun%2Fdocker.sock/info",
    "https:///nohost",
])
async def test_fetch_article_content_rejects_non_http_scheme(monkeypatch, caplog, url):
    """http/https 외 스킴과 호스트 없는 URL은 요청조차 하지 않는다 / Non-http(s) schemes and hostless URLs never reach a request."""
    _patch_dns(monkeypatch)
    calls = _patch_transport(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(url) == ""

    assert calls == []   # GET 호출 자체가 없어야 한다 / no GET may be issued
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_url_rejected" and p.get("url") == url for p in payloads)


@pytest.mark.parametrize("address", INTERNAL_ADDRESSES)
async def test_fetch_article_content_rejects_host_resolving_to_internal_address(monkeypatch, caplog, address):
    """내부망/메타데이터 주소로 해석되는 호스트는 거부 / A host resolving to an internal or metadata address is rejected."""
    lookups = _patch_dns(monkeypatch, {"example.com": address})
    calls = _patch_transport(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    assert lookups == ["example.com"]   # 해석은 했고 / resolved,
    assert calls == []                  # 요청은 안 했다 / but never requested
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_url_rejected" and address in p.get("addresses", [])
               for p in payloads)


@pytest.mark.parametrize("address", INTERNAL_ADDRESSES)
async def test_fetch_article_content_rejects_bare_internal_ip_url(monkeypatch, caplog, address):
    """호스트가 내부망 IP 리터럴이면 DNS를 거치지 않고 거부 / A bare internal IP host is rejected without any DNS lookup."""
    # DNS는 공개 주소를 주도록 스텁 -> 그래도 거부되어야 한다 (IP 리터럴은 해석하지 않는다)
    # DNS is stubbed to a public address; rejection must still happen (IP literals skip resolution)
    lookups = _patch_dns(monkeypatch)
    calls = _patch_transport(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(f"http://{address}/latest/meta-data/") == ""

    assert lookups == []
    assert calls == []
    assert any(p.get("event") == "article_url_rejected" for p in _warning_payloads(caplog))


@pytest.mark.parametrize("host", [
    "[::1]",                        # IPv6 loopback
    "[::ffff:169.254.169.254]",     # IPv4-mapped 메타데이터 / IPv4-mapped metadata address
    "[fd00::1]",                    # IPv6 unique-local
    "[fe80::1]",                    # IPv6 link-local
])
async def test_fetch_article_content_rejects_internal_ipv6_literals(monkeypatch, caplog, host):
    """IPv6 리터럴(IPv4-mapped 포함)도 내부망이면 거부 / Internal IPv6 literals, IPv4-mapped included, are rejected."""
    lookups = _patch_dns(monkeypatch)
    calls = _patch_transport(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(f"http://{host}/") == ""

    assert lookups == [] and calls == []
    assert any(p.get("event") == "article_url_rejected" for p in _warning_payloads(caplog))


async def test_fetch_article_content_rejects_obfuscated_host_via_resolved_address(monkeypatch, caplog):
    """
    10진수/8진수 위장 호스트는 해석 결과로 걸러진다 / Decimal and octal host forms are caught by the resolved address.

    이 형태들은 IP 리터럴로 파싱되지 않아 DNS를 타므로, 방어선은 "해석된 주소" 검사다.
    They do not parse as IP literals and therefore go through DNS, so the resolved-address check is the defense.
    """
    _patch_dns(monkeypatch, {"2130706433": "127.0.0.1", "0177.0.0.1": "127.0.0.1"})
    calls = _patch_transport(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content("http://2130706433/admin") == ""
        assert await news.fetch_article_content("http://0177.0.0.1/admin") == ""

    assert calls == []
    rejected = [p for p in _warning_payloads(caplog) if p.get("event") == "article_url_rejected"]
    assert len(rejected) == 2
    assert all(p.get("addresses") == ["127.0.0.1"] for p in rejected)


async def test_fetch_article_content_strips_userinfo_when_validating_host(monkeypatch, caplog):
    """`user@internal` 형태의 userinfo 위장도 실제 호스트로 검증 / A `user@internal` userinfo trick validates the real host."""
    lookups = _patch_dns(monkeypatch)
    calls = _patch_transport(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content("http://example.com@169.254.169.254/latest/") == ""

    assert lookups == [] and calls == []
    assert any(p.get("event") == "article_url_rejected" for p in _warning_payloads(caplog))


async def test_fetch_article_content_rejects_when_any_address_is_internal(monkeypatch, caplog):
    """공개 주소와 내부 주소가 섞여 있으면 거부 (DNS rebinding 방어) / A mixed public/internal answer is rejected (DNS-rebinding defense)."""
    _patch_dns(monkeypatch, {"example.com": [PUBLIC_IP, "10.1.2.3"]})
    calls = _patch_transport(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    assert calls == []
    payloads = _warning_payloads(caplog)
    assert any(p.get("addresses") == ["10.1.2.3"] for p in payloads)


async def test_fetch_article_content_rejects_unresolvable_host(monkeypatch, caplog):
    """호스트 해석 실패는 경고 + 빈 문자열 / A resolution failure warns and returns ""."""
    _patch_dns(monkeypatch, {"example.com": socket.gaierror("no such host")})
    calls = _patch_transport(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    assert calls == []
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_host_unresolved" and p.get("host") == "example.com"
               for p in payloads)


async def test_fetch_article_content_public_host_proceeds(monkeypatch):
    """공개 주소로 해석되면 정상 추출 / A public address resolves and extraction proceeds."""
    lookups = _patch_dns(monkeypatch, {"example.com": PUBLIC_IP})
    html = "<article><p>Public article body paragraph that is long enough.</p></article>"
    calls = _patch_transport(monkeypatch, {ARTICLE_URL: _resp(html)})

    content = await news.fetch_article_content(ARTICLE_URL)

    assert content == "Public article body paragraph that is long enough."
    assert lookups == ["example.com"]
    assert [c["url"] for c in calls] == [ARTICLE_URL]


async def test_fetch_article_content_revalidates_redirect_target(monkeypatch, caplog):
    """리다이렉트 대상도 다시 검증한다 - 내부망으로 유도하면 차단 / Redirect targets are re-validated; an internal hop is blocked."""
    internal_url = "http://169.254.169.254/latest/meta-data/"
    _patch_dns(monkeypatch, {"example.com": PUBLIC_IP})
    calls = _patch_transport(monkeypatch, {
        ARTICLE_URL: _resp("", status_code=302, headers={"location": internal_url}),
    })

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    # 첫 홉만 요청되고 두 번째 홉은 가드에서 막힌다 / only the first hop is requested; the second is blocked
    assert [c["url"] for c in calls] == [ARTICLE_URL]
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_url_rejected" and p.get("url") == internal_url
               for p in payloads)


async def test_fetch_article_content_never_requests_a_private_redirect_target(monkeypatch, caplog):
    """
    내부망으로 유도하는 302는 **요청 자체가 일어나지 않는다** / A 302 toward the internal network is never requested.

    앞 테스트와 달리 내부 URL에 진짜 응답(메타데이터 토큰 흉내)을 등록해 둔다: 리다이렉트를 httpx에
    맡겨(`follow_redirects=True`) 홉별 재검증이 사라지면 이 응답이 그대로 본문으로 흘러나온다.
    Unlike the previous test, the internal URL is wired to a real response (a stand-in metadata token):
    if redirects were delegated to httpx (`follow_redirects=True`) and the per-hop re-validation stopped
    running, that body would come straight back as the article.
    """
    internal_url = "http://169.254.169.254/"
    secret = "IMDS-CREDENTIAL-LEAK token that is long enough to survive extraction."
    _patch_dns(monkeypatch, {"example.com": PUBLIC_IP})
    calls = _patch_transport(monkeypatch, {
        ARTICLE_URL: _resp("", status_code=302, headers={"location": internal_url}),
        internal_url: _resp(f"<article><p>{secret}</p></article>"),
    })

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        content = await news.fetch_article_content(ARTICLE_URL)

    assert content == ""
    assert secret not in content
    assert [c["url"] for c in calls] == [ARTICLE_URL]   # 내부 홉은 트랜스포트에 닿지 못한다 / the internal hop never reaches the transport
    assert any(p.get("event") == "article_url_rejected" and p.get("url") == internal_url
               for p in _warning_payloads(caplog))


async def test_fetch_article_content_follows_public_redirect(monkeypatch):
    """공개 호스트 리다이렉트는 따라간다 (상대 Location 포함) / Redirects to public hosts are followed (relative Location included)."""
    final_url = "https://example.com/story/final"
    _patch_dns(monkeypatch, {"example.com": PUBLIC_IP})
    calls = _patch_transport(monkeypatch, {
        ARTICLE_URL: _resp("", status_code=301, headers={"location": "/story/final"}),
        final_url: _resp("<article><p>Redirected article body, long enough to keep.</p></article>"),
    })

    content = await news.fetch_article_content(ARTICLE_URL)

    assert content == "Redirected article body, long enough to keep."
    assert [c["url"] for c in calls] == [ARTICLE_URL, final_url]


async def test_fetch_article_content_stops_after_max_redirects(monkeypatch, caplog):
    """리다이렉트 루프는 상한에서 중단 / A redirect loop stops at the cap."""
    _patch_dns(monkeypatch, {"example.com": PUBLIC_IP})
    calls = _patch_transport(monkeypatch, {
        ARTICLE_URL: _resp("", status_code=302, headers={"location": ARTICLE_URL}),
    })

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    assert len(calls) == news.MAX_REDIRECTS + 1   # 최초 1회 + 리다이렉트 상한 / initial request plus the cap
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_too_many_redirects" for p in payloads)


async def test_fetch_article_content_ignores_oversized_declared_length(monkeypatch, caplog):
    """
    상한 초과를 선언해도 거부하지 않는다 — 스트리밍 캡이 실제 방어선이다.
    An oversized *declared* content-length no longer rejects the fetch; the streaming cap is the guard.

    2026-08-03 회귀 수정: 옛 사전 필터는 선언 크기 초과를 전면 거부해, 큰 페이지를 정직하게
    선언하는 실제 뉴스 사이트(Yahoo ~856KB)의 기사 분석을 전멸시켰다. 같은 페이지가 chunked면
    잘라서 진행했으므로 비일관이기도 했다. 이제 선언값은 읽지 않고 항상 캡까지 스트리밍한다.
    Regression fix 2026-08-03: the old pre-filter hard-rejected any oversized declaration, killing
    article analysis for real news sites that declare big pages honestly (Yahoo ~856KB) — while the
    same page sent chunked was truncated and processed. The declaration is now ignored; the body is
    always streamed up to the cap.
    """
    _patch_dns(monkeypatch)
    html = "<article><p>Body that would otherwise be extracted fine.</p></article>"
    _patch_transport(monkeypatch, {
        ARTICLE_URL: _resp(html, headers={"content-length": str(news.MAX_ARTICLE_SIZE + 1)}),
    })

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        content = await news.fetch_article_content(ARTICLE_URL)

    assert content == "Body that would otherwise be extracted fine."
    payloads = _warning_payloads(caplog)
    assert not any(p.get("event") == "article_too_large" for p in payloads)


async def test_fetch_article_content_extracts_a_real_world_sized_page(monkeypatch):
    """
    본문이 늦게 시작하는 대형 페이지에서 추출된다 / A large page whose body starts late still extracts.

    실측 근거 (2026-08-03, Yahoo Finance 기사): 페이지 789-856KB, `<article>` 시작 오프셋 ~310KB.
    옛 상한 256KB는 본문이 시작되기도 전에 끝나 — 선언 거부를 없애도 추출이 불가능했다.
    이 테스트는 그 형태를 재현해 상한이 실세계 뉴스 페이지보다 작아지는 회귀를 막는다.
    Measured basis (2026-08-03, a Yahoo Finance article): the page is 789-856KB and `<article>` starts
    around offset 310KB. The old 256KB cap ended before the body began, so even without the declared-size
    rejection nothing could be extracted. This test reproduces that shape and pins the cap above
    real-world news pages.
    """
    _patch_dns(monkeypatch)
    paragraph = "Real article body paragraph that survives on a large real-world page."
    # 실측 페이지(789-856KB)의 형태를 그대로 고정한다: 본문 앞 ~700KB 스크립트 덩어리.
    # 캡을 실측 페이지 아래로 내리는 회귀는 이 테스트가 잡는다 (2026-08-03 보안 리뷰 F5).
    # Pins the measured page's shape: ~700KB of pre-body script. Lowering the cap below real measured
    # pages is what this test catches (security review F5, 2026-08-03).
    junk = '<script>{"data":"%s"}</script>' % ("j" * 700_000)
    html = f"<html><head></head><body>{junk}<article><p>{paragraph}</p></article></body></html>"
    assert len(html) > 700_000
    _patch_transport(monkeypatch, {
        ARTICLE_URL: _resp(html, headers={"content-length": str(len(html))}),
    })

    assert await news.fetch_article_content(ARTICLE_URL) == paragraph


async def test_fetch_article_content_truncates_when_declared_and_actual_exceed_cap(monkeypatch, caplog):
    """
    선언·실제 모두 상한 초과면 chunked와 동일하게 잘라서 진행한다.
    When both the declared and the actual size exceed the cap, behave exactly like the chunked path:
    truncate at the cap and extract what fits.
    """
    _patch_dns(monkeypatch)
    body = _oversized_body().decode()
    _patch_transport(monkeypatch, {
        ARTICLE_URL: _resp(body, headers={"content-length": str(len(body))}),
    })

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        content = await news.fetch_article_content(ARTICLE_URL)

    assert content == KEPT_PARAGRAPH
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_truncated" for p in payloads)
    assert not any(p.get("event") == "article_too_large" for p in payloads)


async def test_fetch_article_content_ignores_a_hostile_charset(monkeypatch, caplog):
    """
    오리진이 준 charset을 코덱 레지스트리에 그대로 넘기지 않는다 / The origin's charset never reaches the codec registry raw.

    2026-08-03 보안 리뷰 F1: `charset=punycode`는 순수 파이썬 O(n²) 디코더를 고르게 해, 이벤트 루프
    위의 단일 decode 호출이 분 단위로 멈춘다 (실측: 256KB 2.3s, 2MB ~140s — 헬스체크 5s 임계 초과로
    태스크 교체까지 간다). 화이트리스트(C 구현 코덱) 밖의 charset은 utf-8로 폴백하고 경고를 남긴다.
    Security review F1 (2026-08-03): `charset=punycode` selects a pure-Python O(n²) decoder, stalling a
    single on-loop decode call for minutes (measured 2.3s at 256KB, ~140s at 2MB — past the 5s health
    check threshold, up to task replacement). A charset outside the C-codec whitelist falls back to
    utf-8 with a warning.
    """
    _patch_dns(monkeypatch)
    paragraph = "Body that must decode as utf-8 despite the hostile charset header."
    filler = "x" * 262_144   # 구 캡 크기에서도 punycode는 ~2.3s — 1초 상한이 회귀를 명확히 잡는다
    html = f"<article><p>{paragraph}</p></article><!--{filler}-->"
    _patch_transport(monkeypatch, {
        ARTICLE_URL: httpx.Response(
            200, content=html.encode(),
            headers={"content-type": "text/html; charset=punycode"},
        ),
    })

    started = time.perf_counter()
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        content = await news.fetch_article_content(ARTICLE_URL)
    elapsed = time.perf_counter() - started

    assert content == paragraph
    assert elapsed < 1.0, f"decode took {elapsed:.1f}s - a hostile charset reached the codec registry"
    assert any(p.get("event") == "article_charset_ignored" and p.get("charset") == "punycode"
               for p in _warning_payloads(caplog))


class _TrickleStream(httpx.AsyncByteStream):
    """청크 사이에 지연을 두고 '한 방울씩' 흘리는 스트림 / A stream that dribbles chunks with a delay between them."""

    def __init__(self, chunk: bytes, chunks: int, delay: float) -> None:
        self.chunk = chunk
        self.chunks = chunks
        self.delay = delay

    async def __aiter__(self):
        import asyncio as _asyncio
        for _ in range(self.chunks):
            await _asyncio.sleep(self.delay)
            yield self.chunk


async def test_fetch_article_content_enforces_a_total_deadline(monkeypatch, caplog):
    """
    per-read 타임아웃만으로는 trickle을 못 막는다 — 총 데드라인이 fetch 전체를 묶는다.
    A per-read timeout cannot stop a trickle; a total deadline bounds the whole fetch.

    2026-08-03 보안 리뷰 F2: httpx `timeout`은 read당 비활동 타임아웃이라, 캡 직전까지 빠르게 보낸 뒤
    몇 초에 한 바이트씩 흘리는 오리진이 수 MB 버퍼를 사실상 무기한 점유할 수 있었다.
    Security review F2 (2026-08-03): httpx's `timeout` is a per-read inactivity timeout, so an origin
    that sends fast up to just under the cap and then dribbles a byte every few seconds could hold
    multi-MB buffers essentially forever.
    """
    _patch_dns(monkeypatch)
    monkeypatch.setattr(news, "FETCH_TOTAL_DEADLINE", 0.2, raising=False)
    stream = _TrickleStream(chunk=b"<p>chunk</p>", chunks=50, delay=0.05)   # 다 읽으면 2.5s / 2.5s if fully read
    _patch_transport(monkeypatch, {ARTICLE_URL: _streamed(stream)})

    started = time.perf_counter()
    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        content = await news.fetch_article_content(ARTICLE_URL)
    elapsed = time.perf_counter() - started

    assert content == ""
    assert elapsed < 1.0, f"fetch ran {elapsed:.1f}s - the total deadline did not bind"
    assert any(p.get("event") == "article_fetch_timeout" for p in _warning_payloads(caplog))


KEPT_PARAGRAPH = "Kept paragraph that sits before the size cap and is long enough."


def _oversized_body(multiple: int = 4) -> bytes:
    """
    상한을 훌쩍 넘는 본문 (content-length 없이 흘려보낼 용도) / A body well past the cap, for chunked streaming.

    앞쪽에 살아남을 단락 하나, 뒤에 상한을 넘기는 filler와 버려질 단락을 둔다.
    One surviving paragraph up front, then filler that crosses the cap and a paragraph that must be lost.
    """
    head = f"<article><p>{KEPT_PARAGRAPH}</p>"
    filler = "<p>%s</p>" % ("x" * (news.MAX_ARTICLE_SIZE * multiple))
    tail = "<p>Dropped paragraph living past the size cap boundary line.</p></article>"
    return (head + filler + tail).encode()


async def test_fetch_article_content_truncates_oversized_body(monkeypatch, caplog):
    """
    상한을 넘는 본문은 상한까지만 파싱한다 / An oversized body is parsed only up to the cap.

    content-length 없이 청크로 흘려보낸다 (chunked 응답 = 선언 크기 사전 필터가 못 잡는 경우).
    The body is streamed in chunks with no content-length: a chunked response, which the declared-size
    pre-filter cannot catch.

    상한에서 잘리면 `</article>`도 사라지므로 전략 1은 시작 태그 뒤 고정 창을 훑고, 그 안에서 짝이
    맞는 `<p>`는 첫 단락뿐이다 (상한을 넘긴 filler 단락은 `</p>`가 함께 잘렸다).
    Truncation also cuts `</article>`, so stage 1 scans the fixed window after the opening tag, where the
    only properly paired `<p>` is the first paragraph - the filler that crossed the cap lost its `</p>` too.
    """
    _patch_dns(monkeypatch)
    stream = _ChunkStream(_oversized_body(), chunk_size=16_384)
    _patch_transport(monkeypatch, {ARTICLE_URL: _streamed(stream)})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        content = await news.fetch_article_content(ARTICLE_URL)

    assert len(KEPT_PARAGRAPH) > 50
    assert content == KEPT_PARAGRAPH    # 상한 앞의 본문은 살아남고 / the body before the cap survives
    assert "Dropped paragraph" not in content   # 상한 뒤는 버려진다 / everything past the cap is gone
    assert "xxx" not in content     # 잘린 filler 단락은 매칭되지 않는다 / the cut filler paragraph never matches
    assert any(p.get("event") == "article_truncated" for p in _warning_payloads(caplog))


async def test_fetch_article_content_stops_reading_at_the_cap(monkeypatch, caplog):
    """
    상한을 넘는 순간 읽기를 끊는다 - 남은 본문을 버퍼링하지 않는다.
    Reading stops the moment the cap is crossed; the rest of the body is never buffered.

    `response.text`처럼 전체를 먼저 메모리에 올리면 모든 청크가 소비되므로 이 단정이 깨진다
    (= 크기 상한이 "다 읽은 뒤 자르기"로 퇴화했다는 신호).
    Materializing the whole body first (as `response.text` does) consumes every chunk and breaks this
    assertion - exactly the signal that the cap degenerated into "read everything, then trim".
    """
    _patch_dns(monkeypatch)
    stream = _ChunkStream(_oversized_body(multiple=8), chunk_size=16_384)
    _patch_transport(monkeypatch, {ARTICLE_URL: _streamed(stream)})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == KEPT_PARAGRAPH

    # 상한을 덮는 청크 수 + 상한을 넘긴 마지막 1개까지만 소비된다 / cap-worth of chunks, plus the one that crossed it
    expected = news.MAX_ARTICLE_SIZE // stream.chunk_size + 1
    assert stream.chunks_pulled == expected
    assert stream.chunks_pulled < stream.chunk_total // 4   # 전체의 4분의 1도 읽지 않았다 / far short of the whole body
    assert any(p.get("event") == "article_truncated" for p in _warning_payloads(caplog))


async def test_fetch_article_content_requests_identity_encoding(monkeypatch):
    """
    기사 조회는 압축을 요청하지 않는다 / Article fetches never ask for compression.

    압축 해제 폭탄의 전제(작은 압축 본문 -> 거대한 실제 본문)를 요청 단계에서 없앤다.
    This removes the premise of a decompression bomb (a small compressed body, a huge real one).
    """
    _patch_dns(monkeypatch)
    html = "<article><p>Body long enough to be extracted from the article tag.</p></article>"
    calls = _patch_transport(monkeypatch, {ARTICLE_URL: _resp(html)})

    assert await news.fetch_article_content(ARTICLE_URL)

    assert [c["accept_encoding"] for c in calls] == ["identity"]


async def test_fetch_article_content_survives_a_gzip_decompression_bomb(monkeypatch, caplog):
    """
    압축 해제 폭탄이 크기 상한을 우회하지 못한다 / A decompression bomb cannot bypass the size cap.

    20KB 남짓의 gzip 본문이 20MB로 부풀지만, 상한 검사는 **압축 해제된** 바이트를 세므로 첫 청크에서
    끊긴다. 정직한 content-length(압축 크기 = 상한 이내)는 사전 필터를 통과하기 때문에, 이 방어선은
    스트리밍 카운터뿐이다.
    A ~20KB gzip body inflates to 20MB, but the cap counts *decompressed* bytes and so breaks on the first
    chunk. The honest content-length (the compressed size, within the cap) sails through the pre-filter,
    which leaves the streaming counter as the only defense.
    """
    _patch_dns(monkeypatch)
    bomb = gzip.compress(f"<p>{KEPT_PARAGRAPH}</p>".encode() + b"x" * 20_000_000)
    stream = _ChunkStream(bomb, chunk_size=1024)
    _patch_transport(monkeypatch, {ARTICLE_URL: _streamed(stream, headers={
        "content-encoding": "gzip",
        "content-length": str(len(bomb)),
        "content-type": "text/html; charset=utf-8",
    })})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        content = await news.fetch_article_content(ARTICLE_URL)

    assert len(bomb) < news.MAX_ARTICLE_SIZE          # 선언 크기는 상한 이내다 / the declared size is within the cap
    assert content == KEPT_PARAGRAPH
    assert "xxx" not in content
    # 압축 본문을 조기에 끊는다: 'x' 연속은 ~1000:1로 풀리므로 1KB 압축 청크 하나가 ~1MB가 되고,
    # 압축 해제 카운터가 상한(2MB)을 넘긴 직후 읽기가 멈춘다 (전체 ~20청크 중 2-3개).
    # 이 수는 상한에 비례한다 — 상한 값에 결합된 매직 넘버를 두지 않는다 (2026-08-03, 상한 2MB 상향 때 정정).
    # The compressed body is cut early: an 'x' run inflates ~1000:1, so one 1KB compressed chunk becomes
    # ~1MB and the read stops right after the decompressed counter crosses the cap (2-3 of ~20 chunks).
    # The count scales with the cap — no magic number tied to the cap's value (corrected 2026-08-03).
    assert stream.chunks_pulled <= 4
    assert stream.chunks_pulled < stream.chunk_total
    assert any(p.get("event") == "article_truncated" for p in _warning_payloads(caplog))


async def test_fetch_article_content_declared_length_within_cap_is_kept(monkeypatch):
    """상한 이내의 content-length는 정상 처리 / A content-length within the cap passes through."""
    _patch_dns(monkeypatch)
    html = "<article><p>Normal sized article body paragraph, long enough.</p></article>"
    _patch_transport(monkeypatch, {
        ARTICLE_URL: _resp(html, headers={"content-length": str(len(html))}),
    })

    assert await news.fetch_article_content(ARTICLE_URL) == "Normal sized article body paragraph, long enough."


async def test_feed_fetches_are_unaffected_by_article_guard(monkeypatch):
    """피드 URL은 코드 고정이므로 DNS 스텁 없이도 동작해야 한다 / Feed URLs are code-fixed, so they work without any DNS stub."""
    routes = {url: _resp(_numbered_rss(1, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    _patch_transport(monkeypatch, routes)

    # getaddrinfo는 autouse 가드가 여전히 막고 있다 (기사 가드가 피드 경로에 새지 않았다는 증거)
    # getaddrinfo is still blocked by the autouse guard, proving the article guard did not leak here
    assert len(await news.fetch_news()) == 4
