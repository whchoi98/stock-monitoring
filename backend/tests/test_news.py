"""
뉴스 서비스 테스트 - 고정 RSS/HTML 문자열 + `httpx.AsyncClient.get` monkeypatch (실제 네트워크 호출 없음)
News service tests - fixed RSS/HTML strings plus a monkeypatched `httpx.AsyncClient.get` (no real network calls).
"""
import hashlib
import json
import logging
import socket

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


class FakeResponse:
    """httpx.Response 대역 (status_code/text/headers만 사용) / Stand-in for httpx.Response (status_code/text/headers only)."""

    def __init__(self, text: str = "", status_code: int = 200, headers=None):
        self.text = text
        self.status_code = status_code
        # 실제 httpx 헤더는 대소문자 무시 - 구현이 소문자로 조회하므로 소문자 키를 쓴다
        # Real httpx headers are case-insensitive; the implementation reads lowercase keys
        self.headers = headers or {}


def _patch_get(monkeypatch, routes):
    """
    `httpx.AsyncClient.get`을 URL->응답 매핑으로 대체하고 호출을 기록.
    Replace `httpx.AsyncClient.get` with a URL->response mapping, recording every call.

    값이 Exception이면 raise한다 (피드 실패 시나리오) / An Exception value is raised (feed-failure scenario).
    """
    calls = []

    async def fake_get(self, url, **kwargs):
        calls.append({"url": url, "user_agent": self.headers.get("user-agent")})
        if url not in routes:
            raise AssertionError(f"unexpected URL requested: {url}")
        outcome = routes[url]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
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
    routes = {url: FakeResponse(_numbered_rss(2, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    routes[config.NEWS_FEEDS["yahoo"]] = FakeResponse(BILLION_LAUGHS)
    _patch_get(monkeypatch, routes)

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
    routes = {url: FakeResponse(_numbered_rss(2, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    calls = _patch_get(monkeypatch, routes)

    items = await news.fetch_news()

    assert len(config.NEWS_FEEDS) == 4
    assert sorted(c["url"] for c in calls) == sorted(config.NEWS_FEEDS.values())
    assert len(items) == 8
    # 한국 소스(hankyung/mk)만 ko / Only the Korean sources (hankyung/mk) are ko
    languages = {i.title.split()[0]: i.language for i in items}
    assert languages == {"yahoo": "en", "yahoo_markets": "en", "hankyung": "ko", "mk": "ko"}


async def test_fetch_news_sends_browser_user_agent(monkeypatch):
    """TUI와 동일한 User-Agent 헤더 전송 / Sends the same User-Agent header as the TUI."""
    routes = {url: FakeResponse(_numbered_rss(1)) for url in config.NEWS_FEEDS.values()}
    calls = _patch_get(monkeypatch, routes)

    await news.fetch_news()

    assert calls and all(c["user_agent"] == "Mozilla/5.0 (StockMonitor/1.0)" for c in calls)


async def test_fetch_news_caps_items_per_source(monkeypatch):
    """소스당 max_per_source개까지만 반환 / At most max_per_source items come back per source."""
    routes = {url: FakeResponse(_numbered_rss(12)) for url in config.NEWS_FEEDS.values()}
    _patch_get(monkeypatch, routes)

    assert len(await news.fetch_news(max_per_source=3)) == 12   # 3 * 4 feeds
    assert len(await news.fetch_news()) == 40                   # 기본 10 * 4 / default 10 * 4


async def test_fetch_news_one_feed_fails_others_survive(monkeypatch, caplog):
    """피드 1개가 실패해도 나머지 3개 결과는 반환 + 경고 / One failing feed still returns the other three, with a warning."""
    routes = {url: FakeResponse(_numbered_rss(2, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    broken_url = config.NEWS_FEEDS["hankyung"]
    routes[broken_url] = httpx.ConnectTimeout("feed boom")
    _patch_get(monkeypatch, routes)

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        items = await news.fetch_news()

    assert len(items) == 6
    assert all(not i.title.startswith("hankyung") for i in items)
    payloads = _warning_payloads(caplog)
    assert any(p.get("url") == broken_url and "feed boom" in p.get("error", "") for p in payloads)


async def test_fetch_news_non_200_feed_is_skipped_with_warning(monkeypatch, caplog):
    """200이 아닌 피드는 skip + 경고 / A non-200 feed is skipped and warned about."""
    routes = {url: FakeResponse(_numbered_rss(2, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    routes[config.NEWS_FEEDS["mk"]] = FakeResponse("", status_code=503)
    _patch_get(monkeypatch, routes)

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
    calls = _patch_get(monkeypatch, {url: FakeResponse(_numbered_rss(2))})

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
    calls = _patch_get(monkeypatch, {url: FakeResponse(_numbered_rss(2))})

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
    calls = _patch_get(monkeypatch, {url: FakeResponse(_numbered_rss(1))})

    assert len(await news.fetch_company_news("247540.KQ")) == 1
    assert [c["url"] for c in calls] == [url]


async def test_fetch_company_news_caps_at_eight_items(monkeypatch):
    """종목 뉴스는 최대 8건 / Company news is capped at eight items."""
    url = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=MSFT&region=US&lang=en-US"
    _patch_get(monkeypatch, {url: FakeResponse(_numbered_rss(20))})

    assert len(await news.fetch_company_news("MSFT")) == 8


async def test_fetch_company_news_failure_returns_empty_with_warning(monkeypatch, caplog):
    """조회 실패는 경고 + 빈 리스트 / A failed fetch warns and returns an empty list."""
    url = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=TSLA&region=US&lang=en-US"
    _patch_get(monkeypatch, {url: httpx.ConnectError("company boom")})

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
    _patch_get(monkeypatch, {ARTICLE_URL: FakeResponse(html)})

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
    _patch_get(monkeypatch, {ARTICLE_URL: FakeResponse(html)})

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
    _patch_get(monkeypatch, {ARTICLE_URL: FakeResponse(html)})

    assert len(short) == 50
    assert await news.fetch_article_content(ARTICLE_URL) == keep


async def test_fetch_article_content_caps_at_25_paragraphs(monkeypatch):
    """최대 25개 단락까지만 결합 / At most 25 paragraphs are joined."""
    paras = "".join(f"<p>Paragraph number {i} is long enough to be kept.</p>" for i in range(40))
    _patch_dns(monkeypatch)
    _patch_get(monkeypatch, {ARTICLE_URL: FakeResponse(f"<article>{paras}</article>")})

    content = await news.fetch_article_content(ARTICLE_URL)

    parts = content.split("\n\n")
    assert len(parts) == 25
    assert parts[0].startswith("Paragraph number 0")
    assert parts[-1].startswith("Paragraph number 24")


async def test_fetch_article_content_returns_empty_on_fetch_failure(monkeypatch, caplog):
    """조회 실패는 경고 + 빈 문자열 (라우트가 사용자 오류로 변환) / A failed fetch warns and returns "" (the route surfaces the error)."""
    _patch_dns(monkeypatch)
    _patch_get(monkeypatch, {ARTICLE_URL: httpx.ReadTimeout("article boom")})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    payloads = _warning_payloads(caplog)
    assert any(p.get("url") == ARTICLE_URL and "article boom" in p.get("error", "") for p in payloads)


async def test_fetch_article_content_returns_empty_on_non_200(monkeypatch, caplog):
    """200이 아니면 경고 + 빈 문자열 / A non-200 status warns and returns ""."""
    _patch_dns(monkeypatch)
    _patch_get(monkeypatch, {ARTICLE_URL: FakeResponse("<article><p>hidden</p></article>", status_code=403)})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    assert any(p.get("status") == 403 for p in _warning_payloads(caplog))


async def test_fetch_article_content_returns_empty_when_nothing_extractable(monkeypatch, caplog):
    """추출 실패도 조용히 넘기지 않는다 / An unextractable page warns instead of failing silently."""
    _patch_dns(monkeypatch)
    _patch_get(monkeypatch, {ARTICLE_URL: FakeResponse("<html><body><div>no paragraphs</div></body></html>")})

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
    calls = _patch_get(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(url) == ""

    assert calls == []   # GET 호출 자체가 없어야 한다 / no GET may be issued
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_url_rejected" and p.get("url") == url for p in payloads)


@pytest.mark.parametrize("address", INTERNAL_ADDRESSES)
async def test_fetch_article_content_rejects_host_resolving_to_internal_address(monkeypatch, caplog, address):
    """내부망/메타데이터 주소로 해석되는 호스트는 거부 / A host resolving to an internal or metadata address is rejected."""
    lookups = _patch_dns(monkeypatch, {"example.com": address})
    calls = _patch_get(monkeypatch, {})

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
    calls = _patch_get(monkeypatch, {})

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
    calls = _patch_get(monkeypatch, {})

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
    calls = _patch_get(monkeypatch, {})

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
    calls = _patch_get(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content("http://example.com@169.254.169.254/latest/") == ""

    assert lookups == [] and calls == []
    assert any(p.get("event") == "article_url_rejected" for p in _warning_payloads(caplog))


async def test_fetch_article_content_rejects_when_any_address_is_internal(monkeypatch, caplog):
    """공개 주소와 내부 주소가 섞여 있으면 거부 (DNS rebinding 방어) / A mixed public/internal answer is rejected (DNS-rebinding defense)."""
    _patch_dns(monkeypatch, {"example.com": [PUBLIC_IP, "10.1.2.3"]})
    calls = _patch_get(monkeypatch, {})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    assert calls == []
    payloads = _warning_payloads(caplog)
    assert any(p.get("addresses") == ["10.1.2.3"] for p in payloads)


async def test_fetch_article_content_rejects_unresolvable_host(monkeypatch, caplog):
    """호스트 해석 실패는 경고 + 빈 문자열 / A resolution failure warns and returns ""."""
    _patch_dns(monkeypatch, {"example.com": socket.gaierror("no such host")})
    calls = _patch_get(monkeypatch, {})

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
    calls = _patch_get(monkeypatch, {ARTICLE_URL: FakeResponse(html)})

    content = await news.fetch_article_content(ARTICLE_URL)

    assert content == "Public article body paragraph that is long enough."
    assert lookups == ["example.com"]
    assert [c["url"] for c in calls] == [ARTICLE_URL]


async def test_fetch_article_content_revalidates_redirect_target(monkeypatch, caplog):
    """리다이렉트 대상도 다시 검증한다 - 내부망으로 유도하면 차단 / Redirect targets are re-validated; an internal hop is blocked."""
    internal_url = "http://169.254.169.254/latest/meta-data/"
    _patch_dns(monkeypatch, {"example.com": PUBLIC_IP})
    calls = _patch_get(monkeypatch, {
        ARTICLE_URL: FakeResponse("", status_code=302, headers={"location": internal_url}),
    })

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    # 첫 홉만 요청되고 두 번째 홉은 가드에서 막힌다 / only the first hop is requested; the second is blocked
    assert [c["url"] for c in calls] == [ARTICLE_URL]
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_url_rejected" and p.get("url") == internal_url
               for p in payloads)


async def test_fetch_article_content_follows_public_redirect(monkeypatch):
    """공개 호스트 리다이렉트는 따라간다 (상대 Location 포함) / Redirects to public hosts are followed (relative Location included)."""
    final_url = "https://example.com/story/final"
    _patch_dns(monkeypatch, {"example.com": PUBLIC_IP})
    calls = _patch_get(monkeypatch, {
        ARTICLE_URL: FakeResponse("", status_code=301, headers={"location": "/story/final"}),
        final_url: FakeResponse("<article><p>Redirected article body, long enough to keep.</p></article>"),
    })

    content = await news.fetch_article_content(ARTICLE_URL)

    assert content == "Redirected article body, long enough to keep."
    assert [c["url"] for c in calls] == [ARTICLE_URL, final_url]


async def test_fetch_article_content_stops_after_max_redirects(monkeypatch, caplog):
    """리다이렉트 루프는 상한에서 중단 / A redirect loop stops at the cap."""
    _patch_dns(monkeypatch, {"example.com": PUBLIC_IP})
    calls = _patch_get(monkeypatch, {
        ARTICLE_URL: FakeResponse("", status_code=302, headers={"location": ARTICLE_URL}),
    })

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    assert len(calls) == news.MAX_REDIRECTS + 1   # 최초 1회 + 리다이렉트 상한 / initial request plus the cap
    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_too_many_redirects" for p in payloads)


async def test_fetch_article_content_rejects_oversized_declared_length(monkeypatch, caplog):
    """content-length가 상한을 넘으면 본문을 쓰지 않는다 / An oversized declared content-length discards the body."""
    _patch_dns(monkeypatch)
    html = "<article><p>Body that would otherwise be extracted fine.</p></article>"
    _patch_get(monkeypatch, {
        ARTICLE_URL: FakeResponse(html, headers={"content-length": str(news.MAX_ARTICLE_SIZE + 1)}),
    })

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        assert await news.fetch_article_content(ARTICLE_URL) == ""

    payloads = _warning_payloads(caplog)
    assert any(p.get("event") == "article_too_large"
               and p.get("declared") == news.MAX_ARTICLE_SIZE + 1 for p in payloads)


async def test_fetch_article_content_truncates_oversized_body(monkeypatch, caplog):
    """
    상한을 넘는 본문은 상한까지만 파싱한다 / An oversized body is parsed only up to the cap.

    상한에서 잘리면 `</article>`도 사라져 전략 1이 실패하고 전략 3(50자 초과)이 처리한다.
    Truncation also cuts `</article>`, so stage 1 fails and stage 3 (over 50 chars) handles the rest.
    """
    _patch_dns(monkeypatch)
    kept = "Kept paragraph that sits before the size cap and is long enough."
    head = f"<article><p>{kept}</p>"
    filler = "<p>%s</p>" % ("x" * news.MAX_ARTICLE_SIZE)
    tail = "<p>Dropped paragraph living past the size cap boundary line.</p></article>"
    _patch_get(monkeypatch, {ARTICLE_URL: FakeResponse(head + filler + tail)})

    with caplog.at_level(logging.WARNING, logger=LOGGER_NAME):
        content = await news.fetch_article_content(ARTICLE_URL)

    assert len(kept) > 50
    assert content == kept          # 상한 앞의 본문은 살아남고 / the body before the cap survives
    assert "Dropped paragraph" not in content   # 상한 뒤는 버려진다 / everything past the cap is gone
    assert "xxx" not in content     # 잘린 filler 단락은 매칭되지 않는다 / the cut filler paragraph never matches
    assert any(p.get("event") == "article_truncated" for p in _warning_payloads(caplog))


async def test_fetch_article_content_declared_length_within_cap_is_kept(monkeypatch):
    """상한 이내의 content-length는 정상 처리 / A content-length within the cap passes through."""
    _patch_dns(monkeypatch)
    html = "<article><p>Normal sized article body paragraph, long enough.</p></article>"
    _patch_get(monkeypatch, {
        ARTICLE_URL: FakeResponse(html, headers={"content-length": str(len(html))}),
    })

    assert await news.fetch_article_content(ARTICLE_URL) == "Normal sized article body paragraph, long enough."


async def test_feed_fetches_are_unaffected_by_article_guard(monkeypatch):
    """피드 URL은 코드 고정이므로 DNS 스텁 없이도 동작해야 한다 / Feed URLs are code-fixed, so they work without any DNS stub."""
    routes = {url: FakeResponse(_numbered_rss(1, prefix=key)) for key, url in config.NEWS_FEEDS.items()}
    _patch_get(monkeypatch, routes)

    # getaddrinfo는 autouse 가드가 여전히 막고 있다 (기사 가드가 피드 경로에 새지 않았다는 증거)
    # getaddrinfo is still blocked by the autouse guard, proving the article guard did not leak here
    assert len(await news.fetch_news()) == 4
