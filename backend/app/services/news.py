"""
뉴스 서비스 - RSS 피드 수집(전체/종목별) + 기사 본문 regex 추출
News service - RSS collection (market-wide and per-symbol) plus regex-based article extraction.

TUI 프로젝트(`stock-on-tui/services/news.py`)를 포팅하되 네 가지가 다르다:
Ported from the TUI's `services/news.py`, with four differences:
  1. `httpx.get` 대신 `httpx.AsyncClient`로 비동기화하고 4개 피드를 `asyncio.gather`로 병렬 조회한다.
     Async `httpx.AsyncClient` replaces the blocking `httpx.get`; the four feeds run under `asyncio.gather`.
  2. EN_KO_TERMS 정적 번역과 `[EN]` 접두사는 포팅하지 않는다 (웹은 원문 제목을 그대로 노출).
     The EN_KO_TERMS translation and the `[EN]` prefix are dropped (the web shows original titles).
  3. `published`는 원본 pubDate 문자열을 그대로 담는다 (TUI의 16자 절단/날짜 파싱 없음).
     `published` keeps the raw pubDate string (no 16-char truncation, no date parsing).
  4. 실패 시 한국어 안내 문구 대신 빈 문자열/빈 리스트를 반환한다 (라우트가 사용자 오류로 변환).
     Failures return "" or [] instead of Korean placeholder text (routes turn that into a user-facing error).
  5. `fetch_article_content`는 클라이언트가 준 URL을 받으므로 SSRF/과대응답 가드를 추가했다 (TUI는 없음).
     `fetch_article_content` takes a client-supplied URL, so SSRF and size guards were added (the TUI has none).

`parse_rss`는 네트워크와 무관한 순수 함수다 (단위 테스트 대상).
`parse_rss` is a pure function with no network involvement (unit-tested directly).
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import re
import socket
import xml.etree.ElementTree as ET
from typing import Any, Optional
from urllib.parse import quote_plus, urljoin, urlparse

import httpx

from app.core import config
from app.models import NewsItem

logger = logging.getLogger(__name__)

# RSS/기사 조회 공통 HTTP 설정 / Shared HTTP settings for RSS and article fetches
USER_AGENT = "Mozilla/5.0 (StockMonitor/1.0)"
FETCH_TIMEOUT = 10  # seconds

# 한국어 뉴스 소스 키 / Korean news source keys
KOREAN_SOURCE_KEYS = {"hankyung", "mk"}

# NEWS_FEEDS 키 -> 표기용 출처 라벨 / NEWS_FEEDS key -> display source label
SOURCE_LABELS = {
    "yahoo": "Yahoo",
    "yahoo_markets": "Yahoo",
    "hankyung": "한경",
    "mk": "매경",
}

# 한국 종목 접미사 / Korean ticker suffixes
KR_SUFFIXES = (".KS", ".KQ")

# 종목별 뉴스 최대 건수 / Maximum items for per-symbol news
COMPANY_NEWS_MAX_ITEMS = 8

# 본문 추출 한계 / Article extraction limits
MAX_PARAGRAPHS = 25
MIN_PARAGRAPH_LEN = 20        # 전략 1·2: 본문 컨테이너 내부이므로 기준이 느슨하다 / stages 1-2 sit inside a body container
MIN_LOOSE_PARAGRAPH_LEN = 50  # 전략 3: 페이지 전체를 훑으므로 더 엄격하다 / stage 3 scans the whole page

# 전략 2에서 훑는 기사 본문 CSS 클래스 (국내외 언론사 공통 패턴) / Stage-2 article body CSS classes
ARTICLE_BODY_CLASSES = (
    "article-body", "article_body", "article-content",
    "newsct_article", "news_end", "view_con",
)

# 전략 3에서 걸러낼 네비게이션/광고/약관 문구 / Navigation, ad and boilerplate markers filtered in stage 3
BOILERPLATE_MARKERS = (
    "cookie", "javascript", "subscribe", "sign up", "login",
    "copyright", "privacy policy", "terms of",
)

_ARTICLE_TAG_RE = re.compile(r"<article[^>]*>(.*?)</article>", re.DOTALL)
_PARAGRAPH_RE = re.compile(r"<p[^>]*>(.*?)</p>", re.DOTALL)

# 기사 조회 가드 - URL이 클라이언트에서 오므로 SSRF/과대응답을 막는다 (피드 URL은 코드 고정이라 무관)
# Article fetch guards - the URL is client-supplied, so SSRF and oversized bodies must be blocked
# (feed URLs are code-fixed and need none of this).
ALLOWED_SCHEMES = {"http", "https"}
MAX_REDIRECTS = 3
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
# 본문 상한 (바이트=선언된 content-length, 문자=실제 본문) / Body cap: bytes for the declared content-length, chars for the body
MAX_ARTICLE_SIZE = 2_000_000


# ---------------------------------------------------------------------------
# 유틸리티 / Utilities
# ---------------------------------------------------------------------------

def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


def _clean_html(text: str) -> str:
    """HTML 태그·엔티티를 제거하고 공백을 정리 / Strip HTML tags and entities, then normalize whitespace."""
    clean = re.sub(r"<[^>]+>", "", text)        # HTML 태그 제거 / remove HTML tags
    clean = re.sub(r"&[a-zA-Z]+;", " ", clean)  # HTML 엔티티 제거 / remove HTML entities
    clean = re.sub(r"\s+", " ", clean)          # 연속 공백 정리 / collapse whitespace
    return clean.strip()


def _item_id(link: str) -> str:
    """link의 sha1 앞 16자를 항목 id로 사용 (안정적·URL 안전) / Item id: first 16 chars of the link sha1 (stable, URL-safe)."""
    return hashlib.sha1(link.encode()).hexdigest()[:16]


def _client(follow_redirects: bool = True) -> httpx.AsyncClient:
    """
    공통 헤더/타임아웃이 적용된 AsyncClient / An AsyncClient carrying the shared headers and timeout.

    기사 조회는 `follow_redirects=False`로 만들어 리다이렉트를 직접 따라간다 (대상마다 재검증해야 한다).
    Article fetches pass `follow_redirects=False` and follow hops manually, re-validating each target.
    """
    return httpx.AsyncClient(
        timeout=FETCH_TIMEOUT,
        follow_redirects=follow_redirects,
        headers={"User-Agent": USER_AGENT},
    )


# ---------------------------------------------------------------------------
# 순수 로직: RSS 파싱 / Pure logic: RSS parsing
# ---------------------------------------------------------------------------

def parse_rss(xml_text: str, source: str, is_korean: bool) -> list[NewsItem]:
    """
    RSS XML을 NewsItem 리스트로 파싱 / Parse RSS XML into a list of NewsItem.

    Args:
        xml_text: RSS XML 문서 / the RSS XML document.
        source: 표기용 출처 라벨 (예: "Yahoo", "한경") / display source label (e.g. "Yahoo", "한경").
        is_korean: 한국어 피드 여부 -> language "ko"/"en" / whether the feed is Korean -> language "ko"/"en".

    Returns:
        list[NewsItem] - title이 없는 항목은 건너뛴다. 깨진 XML은 경고 후 빈 리스트.
        list[NewsItem]; items without a title are skipped, broken XML warns and yields [].
    """
    items: list[NewsItem] = []
    language = "ko" if is_korean else "en"

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        _warn("news_rss_parse_failed", source=source, error=str(exc))
        return items

    for element in root.findall(".//item"):
        title = (element.findtext("title") or "").strip()
        link = (element.findtext("link") or "").strip()
        published = (element.findtext("pubDate") or "").strip()

        # 제목이 없는 항목은 표시할 수 없다 / An item without a title cannot be displayed
        if not title:
            continue

        items.append(NewsItem(
            id=_item_id(link),
            title=title,
            link=link,
            source=source,
            published=published,
            language=language,
        ))
    return items


# ---------------------------------------------------------------------------
# RSS 조회 / RSS fetching
# ---------------------------------------------------------------------------

async def _fetch_feed(
    client: httpx.AsyncClient,
    url: str,
    source_label: str,
    is_korean: bool,
    max_items: int,
    **log_fields: Any,
) -> list[NewsItem]:
    """
    RSS 피드 1개를 조회·파싱 (실패는 경고 + 빈 리스트) / Fetch and parse one RSS feed (failures warn and return []).

    한 피드의 실패가 다른 피드를 막지 않도록 모든 예외를 여기서 흡수한다.
    Every exception is absorbed here so one failing feed never blocks the others.
    """
    try:
        response = await client.get(url)
        if response.status_code != 200:
            _warn("news_feed_failed", url=url, status=response.status_code, **log_fields)
            return []
        return parse_rss(response.text, source_label, is_korean)[:max_items]
    except Exception as exc:
        _warn("news_feed_failed", url=url, error=str(exc), **log_fields)
        return []


async def fetch_news(max_per_source: int = 10) -> list[NewsItem]:
    """
    설정된 RSS 피드 전체에서 뉴스 수집 / Collect news from every configured RSS feed.

    Args:
        max_per_source: 소스당 최대 건수 / maximum items kept per source.

    Returns:
        list[NewsItem] - NEWS_FEEDS 정의 순서대로 이어붙인 결과. 실패한 소스는 빠진다.
        list[NewsItem] concatenated in NEWS_FEEDS order; failed sources are simply absent.
    """
    async with _client() as client:
        groups = await asyncio.gather(*[
            _fetch_feed(
                client,
                url,
                SOURCE_LABELS.get(source_key, source_key),
                source_key in KOREAN_SOURCE_KEYS,
                max_per_source,
                source=source_key,
            )
            for source_key, url in config.NEWS_FEEDS.items()
        ])
    return [item for group in groups for item in group]


def _company_feed(symbol: str) -> tuple:
    """
    종목별 뉴스 피드 URL과 언어 결정 / Pick the per-symbol feed URL and language.

    US는 Yahoo Finance headline RSS, KR은 종목명으로 검색하는 Google News RSS를 쓴다
    (KR 티커는 Yahoo 종목 뉴스 커버리지가 사실상 없다).
    US symbols use the Yahoo Finance headline RSS; KR symbols search Google News by company name,
    since Yahoo carries virtually no per-symbol news for KR tickers.
    """
    if symbol.upper().endswith(KR_SUFFIXES):
        # STOCK_NAMES는 접미사가 붙은 전체 심볼이 키다 (예: "005930.KS") / STOCK_NAMES is keyed by the full suffixed symbol
        name = config.STOCK_NAMES.get(symbol, symbol)
        query = quote_plus(f"{name} 주식")
        url = f"https://news.google.com/rss/search?q={query}&hl=ko&gl=KR&ceid=KR:ko"
        return url, "Google", True

    url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US"
    return url, "Yahoo", False


async def fetch_company_news(symbol: str) -> list[NewsItem]:
    """
    특정 종목 관련 뉴스 조회 / Fetch news for a single symbol.

    Args:
        symbol: yfinance 티커 (US `AAPL`, KR `005930.KS`/`247540.KQ`) / yfinance ticker.

    Returns:
        list[NewsItem] - 최대 8건. 조회 실패는 경고 후 빈 리스트.
        list[NewsItem], at most eight; a failed fetch warns and yields [].
    """
    url, source, is_korean = _company_feed(symbol)
    async with _client() as client:
        return await _fetch_feed(
            client, url, source, is_korean, COMPANY_NEWS_MAX_ITEMS, symbol=symbol,
        )


# ---------------------------------------------------------------------------
# 기사 본문 추출 / Article content extraction
# ---------------------------------------------------------------------------

def _paragraphs(html: str, min_len: int, drop_boilerplate: bool = False) -> list[str]:
    """<p> 태그 본문을 정리해 최소 길이 이상만 남긴다 / Clean <p> bodies, keeping those above the minimum length."""
    kept = []
    for raw in _PARAGRAPH_RE.findall(html):
        clean = _clean_html(raw)
        if len(clean) <= min_len:
            continue
        if drop_boilerplate and any(marker in clean.lower() for marker in BOILERPLATE_MARKERS):
            continue
        kept.append(clean)
    return kept


def _extract_paragraphs(html: str) -> list[str]:
    """
    3단계 전략으로 기사 단락 추출 / Extract article paragraphs with a three-stage strategy.

    1. `<article>` 태그 안의 `<p>` (가장 신뢰할 수 있다) / `<p>` inside `<article>` (most reliable).
    2. 대표적인 본문 CSS 클래스 `<div>` 안의 `<p>` / `<p>` inside a well-known article-body `<div>`.
    3. 페이지 전체 `<p>` + 광고·약관 필터 (마지막 폴백) / every `<p>` on the page with an ad/boilerplate filter.
    """
    # 전략 1 / Stage 1
    article_match = _ARTICLE_TAG_RE.search(html)
    if article_match:
        found = _paragraphs(article_match.group(1), MIN_PARAGRAPH_LEN)
        if found:
            return found

    # 전략 2 / Stage 2
    for css_class in ARTICLE_BODY_CLASSES:
        body_match = re.search(
            rf'<div[^>]*class="[^"]*{css_class}[^"]*"[^>]*>(.*?)</div>',
            html, re.DOTALL,
        )
        if body_match:
            found = _paragraphs(body_match.group(1), MIN_PARAGRAPH_LEN)
            if found:
                return found

    # 전략 3 / Stage 3
    return _paragraphs(html, MIN_LOOSE_PARAGRAPH_LEN, drop_boilerplate=True)


def _resolve_addresses(host: str) -> list[str]:
    """
    호스트를 IP 문자열 목록으로 해석 / Resolve a host to a list of IP strings.

    호스트가 이미 IP 리터럴이면 DNS를 거치지 않는다 (bare IP URL도 같은 검사를 받아야 한다).
    An IP literal skips DNS entirely, so a bare-IP URL still goes through the same checks.

    블로킹 호출이므로 `asyncio.to_thread`로 감싸 호출한다 / Blocking, so callers wrap it in `asyncio.to_thread`.
    """
    try:
        ipaddress.ip_address(host)
        return [host]
    except ValueError:
        pass
    return [info[4][0] for info in socket.getaddrinfo(host, None)]


def _is_disallowed_address(address: str) -> bool:
    """
    내부망/예약 대역 주소인지 / Whether an address falls in an internal or reserved range.

    파싱 불가한 주소는 거부한다 (fail-closed; 예: 스코프가 붙은 IPv6 link-local).
    Unparseable addresses are rejected (fail closed; e.g. scoped IPv6 link-local).
    """
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return True
    return (
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    )


async def _is_safe_url(url: str) -> bool:
    """
    기사 URL이 외부 공개 대상인지 검증 (SSRF 차단) / Validate that an article URL targets a public host (SSRF guard).

    스킴 화이트리스트 + 해석된 **모든** 주소가 공개 대역이어야 통과한다 (하나라도 내부면 거부).
    A scheme allowlist plus every resolved address being public; one internal address rejects the URL.
    """
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        _warn("article_url_rejected", url=url, scheme=scheme, reason="scheme not allowed")
        return False

    host = parsed.hostname
    if not host:
        _warn("article_url_rejected", url=url, scheme=scheme, reason="missing host")
        return False

    try:
        addresses = await asyncio.to_thread(_resolve_addresses, host)
    except Exception as exc:
        _warn("article_host_unresolved", url=url, host=host, error=str(exc))
        return False

    blocked = [a for a in addresses if _is_disallowed_address(a)]
    if blocked or not addresses:
        _warn("article_url_rejected", url=url, host=host, addresses=blocked,
              reason="host resolves to a non-public address")
        return False
    return True


def _limited_text(response: Any, url: str) -> Optional[str]:
    """
    크기 상한을 적용해 본문을 문자열로 / Return the body as text under the size cap.

    선언된 content-length가 상한을 넘으면 거부하고, 실제 본문이 넘으면 상한까지 잘라 쓴다.
    An oversized declared content-length is rejected; an oversized body is truncated to the cap.
    """
    declared = response.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_ARTICLE_SIZE:
        _warn("article_too_large", url=url, declared=int(declared))
        return None

    text = response.text
    if len(text) > MAX_ARTICLE_SIZE:
        _warn("article_truncated", url=url, chars=len(text))
        return text[:MAX_ARTICLE_SIZE]
    return text


async def _fetch_html(url: str) -> Optional[str]:
    """
    기사 HTML 조회 - 가드 통과 후 리다이렉트를 직접 따라간다 / Fetch article HTML, following redirects manually behind the guard.

    URL이 클라이언트에서 오므로 매 홉마다 `_is_safe_url`을 다시 실행한다 (리다이렉트로 내부망을
    훑는 것을 막는다). 실패·거부는 모두 경고 + None.
    The URL is client-supplied, so `_is_safe_url` re-runs on every hop, which stops redirect chains
    from probing the internal network. Failures and rejections warn and return None.
    """
    target = url
    async with _client(follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            if not await _is_safe_url(target):
                return None

            try:
                response = await client.get(target)
            except Exception as exc:
                _warn("article_fetch_failed", url=target, error=str(exc))
                return None

            if response.status_code in REDIRECT_STATUSES:
                location = response.headers.get("location", "")
                if location:
                    target = urljoin(target, location)
                    continue

            if response.status_code != 200:
                _warn("article_fetch_failed", url=target, status=response.status_code)
                return None
            return _limited_text(response, target)

    _warn("article_too_many_redirects", url=url, last_url=target)
    return None


async def fetch_article_content(url: str) -> str:
    """
    기사 URL에서 본문 텍스트 추출 / Fetch an article URL and extract its body text.

    URL은 클라이언트가 지정하므로 http/https + 공개 호스트만 허용하고 응답 크기를 제한한다.
    The URL is client-supplied, so only http/https public hosts are allowed and the body size is capped.

    Args:
        url: 기사 URL / the article URL.

    Returns:
        str - 단락을 빈 줄로 이어붙인 본문 (최대 25단락). 조회/추출 실패나 가드 거부 시 ""
        (호출부가 사용자 오류로 변환).
        Paragraphs joined by blank lines (at most 25); "" when the fetch, the extraction or the
        guard rejects the URL, which the caller turns into a user-facing error.
    """
    html = await _fetch_html(url)
    if html is None:
        return ""

    paragraphs = _extract_paragraphs(html)
    if not paragraphs:
        _warn("article_extract_failed", url=url)
        return ""
    return "\n\n".join(paragraphs[:MAX_PARAGRAPHS])
