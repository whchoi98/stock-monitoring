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

`parse_rss`는 네트워크와 무관한 순수 함수다 (단위 테스트 대상).
`parse_rss` is a pure function with no network involvement (unit-tested directly).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import xml.etree.ElementTree as ET
from typing import Any, Optional
from urllib.parse import quote_plus

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


def _client() -> httpx.AsyncClient:
    """공통 헤더/타임아웃이 적용된 AsyncClient / An AsyncClient carrying the shared headers and timeout."""
    return httpx.AsyncClient(
        timeout=FETCH_TIMEOUT,
        follow_redirects=True,
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


async def _fetch_html(url: str) -> Optional[str]:
    """기사 HTML 조회 (실패는 경고 + None) / Fetch article HTML (failures warn and return None)."""
    async with _client() as client:
        try:
            response = await client.get(url)
        except Exception as exc:
            _warn("article_fetch_failed", url=url, error=str(exc))
            return None
        if response.status_code != 200:
            _warn("article_fetch_failed", url=url, status=response.status_code)
            return None
        return response.text


async def fetch_article_content(url: str) -> str:
    """
    기사 URL에서 본문 텍스트 추출 / Fetch an article URL and extract its body text.

    Args:
        url: 기사 URL / the article URL.

    Returns:
        str - 단락을 빈 줄로 이어붙인 본문 (최대 25단락). 조회/추출 실패 시 "" (호출부가 사용자 오류로 변환).
        Paragraphs joined by blank lines (at most 25); "" when the fetch or the extraction fails,
        which the caller turns into a user-facing error.
    """
    html = await _fetch_html(url)
    if html is None:
        return ""

    paragraphs = _extract_paragraphs(html)
    if not paragraphs:
        _warn("article_extract_failed", url=url)
        return ""
    return "\n\n".join(paragraphs[:MAX_PARAGRAPHS])
