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
  6. RSS 파싱은 `xml.etree` 대신 `defusedxml`을 쓴다 (엔티티 확장 DoS·XXE 차단).
     RSS parsing uses `defusedxml` instead of `xml.etree` (entity-expansion DoS and XXE).

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
import zlib
from typing import Any, Iterator, Optional
from urllib.parse import quote_plus, urljoin, urlparse

import httpx
# 원격 3rd-party RSS를 파싱하므로 stdlib 파서를 쓰지 않는다 (내부 엔티티 확장 DoS·XXE 차단)
# Remote third-party RSS is parsed here, so the stdlib parser is avoided (entity-expansion DoS and XXE)
from defusedxml.ElementTree import ParseError, fromstring as xml_fromstring
from defusedxml.common import DefusedXmlException

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

# 전략 2가 본문 컨테이너 시작 태그 뒤로 훑는 최대 창 크기(문자)
# Stage-2 forward window (characters) scanned after the body container's opening tag
ARTICLE_BODY_WINDOW = 100_000

# 전략 3에서 걸러낼 네비게이션/광고/약관 문구 / Navigation, ad and boilerplate markers filtered in stage 3
BOILERPLATE_MARKERS = (
    "cookie", "javascript", "subscribe", "sign up", "login",
    "copyright", "privacy policy", "terms of",
)

# ---------------------------------------------------------------------------
# 추출 정규식 - 백트래킹 상한이 load-bearing이다 / Extraction regexes: the backtracking bounds are load-bearing
#
# 태그 내부를 훑는 클래스는 모두 `[^<>]{0,MAX_TAG_SCAN}` 형태다. 두 가지가 동시에 필요하다:
#   1. `<`를 클래스에서 제외 -> 후보 시작 위치마다 스캔이 "다음 `<`까지"로 끝난다. `[^>]*`는 닫는
#      `>`가 없는 입력에서 매 후보마다 EOF까지 훑어 입력 길이의 제곱이 된다.
#   2. 길이 상한 -> 한 후보가 소비할 수 있는 문자 수 자체를 못박는다 (2중 방어).
# 실측(262KB = 당시 상한, 2026-08-02): `"<div "` 반복 39.4s -> 0.01s 미만,
# `"<p>"` 반복 136.1s -> 0.03s, `"<article>"` 반복 43.4s -> 0.01s 미만, 단락 안 `"<"` 반복 34.2s -> 0.01s 미만.
# Every class that scans inside a tag is `[^<>]{0,MAX_TAG_SCAN}`. Both parts matter:
#   1. excluding `<` ends each candidate's scan at the next `<`, whereas `[^>]*` rescans to EOF per
#      candidate when no closing `>` exists - quadratic in the input length;
#   2. the length bound caps what a single candidate can consume at all (defense in depth).
# Measured at 262KB (the cap at the time) on 2026-08-02: repeated `"<div "` 39.4s -> under 0.01s,
# repeated `"<p>"` 136.1s -> 0.03s, repeated `"<article>"` 43.4s -> under 0.01s, repeated `"<"` inside a
# paragraph 34.2s -> under 0.01s.
#
# 이 상한들이 보장하는 것: 어떤 입력이든 추출 시간이 문서 길이에 선형이라는 것이 아니라,
# **후보 시작 위치당 작업량이 상수로 묶인다**는 것 (문서는 이미 MAX_ARTICLE_SIZE로 제한되어 있다).
# What the bounds guarantee: not that extraction is linear for every conceivable input, but that the
# work per candidate start position is constant-bounded (and the document is already capped at MAX_ARTICLE_SIZE).
# ---------------------------------------------------------------------------

# 태그 하나 안에서 훑을 수 있는 최대 문자 수 / Maximum characters scanned inside a single tag
MAX_TAG_SCAN = 1000

# 전략 1: `<article>` 시작 태그. 본문 끝은 정규식이 아니라 `str.find`로 찾는다 (아래 `_body_window`).
# Stage 1: the `<article>` opening tag; the body end is located with `str.find`, not a regex (`_body_window`).
_ARTICLE_OPEN_RE = re.compile(rf"<article[^<>]{{0,{MAX_TAG_SCAN}}}>")
ARTICLE_CLOSE_TAG = "</article>"

# 단락은 시작/종료 태그를 한 번에 훑고 짝을 맞춘다 (`(.*?)</p>` 게으른 스캔 금지).
# `<p ...>(.*?)</p>`는 `</p>`가 없으면 `<p` 출현마다 EOF까지 훑는다 - 262KB에서 136초를 측정했다.
# Paragraphs come from one pass over both tags, paired up afterwards (no `(.*?)</p>` lazy scan).
# `<p ...>(.*?)</p>` rescans to EOF per `<p` when no `</p>` exists - 136 seconds measured at 262KB.
_P_TAG_RE = re.compile(rf"<p[^<>]{{0,{MAX_TAG_SCAN}}}>|</p>")

# 전략 2: 본문 컨테이너의 **시작 태그만** 찾는다 (닫는 태그까지 게으르게 훑지 않는다).
# `<div ...>(.*?)</div>` 형태는 중첩 `<div>`가 있는 정상 기사에서 첫 내부 `</div>`에서 본문을 끊고,
# `</div>`가 없으면 이차 스캔이 된다. 시작 태그 + 고정 창(`ARTICLE_BODY_WINDOW`)이 둘 다 없앤다.
# Stage 2 matches only the container's *opening tag*. A `<div ...>(.*?)</div>` pattern truncates a
# legitimate article at the first nested `</div>` and degenerates into a quadratic scan when no `</div>`
# exists; an opening-tag match plus a fixed forward window (`ARTICLE_BODY_WINDOW`) removes both.
_BODY_CLASS_RES = tuple(
    re.compile(
        rf'<div[^<>]{{0,{MAX_TAG_SCAN}}}class="[^"<>]{{0,{MAX_TAG_SCAN}}}{css_class}'
        rf'[^"<>]{{0,{MAX_TAG_SCAN}}}"[^<>]{{0,{MAX_TAG_SCAN}}}>'
    )
    for css_class in ARTICLE_BODY_CLASSES
)

# `_clean_html`용 - 태그/엔티티 제거도 같은 상한을 받는다 (단락 본문은 적대적일 수 있다).
# For `_clean_html`: tag and entity stripping take the same bounds (a paragraph body can be hostile too).
_HTML_TAG_RE = re.compile(rf"<[^<>]{{0,{MAX_TAG_SCAN}}}>")
_HTML_ENTITY_RE = re.compile(r"&[a-zA-Z]{1,32};")
_WHITESPACE_RE = re.compile(r"\s+")

# 기사 조회 가드 - URL이 클라이언트에서 오므로 SSRF/과대응답을 막는다 (피드 URL은 코드 고정이라 무관)
# Article fetch guards - the URL is client-supplied, so SSRF and oversized bodies must be blocked
# (feed URLs are code-fixed and need none of this).
ALLOWED_SCHEMES = {"http", "https"}
MAX_REDIRECTS = 3
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
# fetch 전체(리다이렉트 포함)의 총 데드라인 (초). httpx `timeout`은 read당 비활동 타임아웃이라,
# 캡 직전까지 빠르게 보낸 뒤 몇 초에 한 바이트씩 흘리는 오리진(trickle)이 수 MB 버퍼를 사실상
# 무기한 점유할 수 있다 — 총 데드라인이 그 채널을 닫는다 (2026-08-03 보안 리뷰 F2).
# Total deadline (seconds) for the whole fetch including redirects. httpx's `timeout` is a per-read
# inactivity timeout, so a trickling origin (fast up to just under the cap, then a byte every few
# seconds) could hold multi-MB buffers essentially forever — the total deadline closes that channel
# (security review F2, 2026-08-03).
FETCH_TOTAL_DEADLINE = 20
# 디코드에 허용하는 charset 화이트리스트 — 오리진이 준 charset을 코덱 레지스트리에 그대로 넘기면
# `punycode` 같은 순수 파이썬 O(n²) 코덱이 이벤트 루프 위의 decode 한 번을 분 단위로 만든다
# (실측: 256KB 2.3s, 2MB ~140s — 2026-08-03 보안 리뷰 F1). 아래는 전부 C 구현이라 2MB에서도 ms다.
# 목록 밖(또는 미선언) charset은 utf-8 + errors="replace"로 폴백한다.
# Charset whitelist for decoding — passing the origin's charset straight to the codec registry lets a
# pure-Python O(n²) codec like `punycode` turn one on-loop decode into minutes (measured 2.3s at 256KB,
# ~140s at 2MB; security review F1, 2026-08-03). Everything below is C-implemented (ms at 2MB); any
# other or missing charset falls back to utf-8 with errors="replace".
SAFE_CHARSETS = {
    "utf-8", "utf8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be",
    "latin-1", "latin1", "iso-8859-1", "iso-8859-15", "ascii", "us-ascii",
    "cp949", "euc-kr", "ms949",
    # 실사용 레거시 인코딩 (전부 C 구현, 2MB에서 0.79-7.19ms 실측 — 2026-08-03 리뷰 권고)
    # Common legacy encodings (all C-implemented, measured 0.79-7.19ms at 2MB — review recommendation)
    "windows-1252", "cp1252", "shift_jis", "shift-jis", "sjis",
    "euc-jp", "gbk", "gb2312", "big5",
}
# 본문 상한 (바이트) - 실제로 읽는 원시 HTML에 적용한다 (스트리밍 카운터가 상한에서 읽기를 끊는다).
# 2MB인 이유 (2026-08-03 실측, 사용자 승인): 실제 뉴스 페이지는 원시 HTML이 크고 본문이 늦게 나온다 -
# Yahoo Finance 기사가 789-856KB에 `<article>` 시작 오프셋 ~310KB였다. 옛 256KB는 본문 시작 전에
# 끝나 기사 분석을 전멸시켰다. "추출 결과는 6000자만 프롬프트에 실린다"는 옛 논거는 추출된 본문
# 크기 이야기라 원시 HTML 상한의 근거가 못 된다. 2MB는 여전히 유한한 DoS 상한이고, 추출 정규식은
# 후보당 상수 작업량이라(위 참조) 2MB에서도 선형이다.
# Body cap in bytes, applied to the raw HTML actually read (the streaming counter stops at the cap).
# Why 2MB (measured 2026-08-03, user-approved): real news pages ship large raw HTML with a late body -
# a Yahoo Finance article was 789-856KB with `<article>` starting around offset 310KB. The old 256KB cap
# ended before the body began, killing article analysis outright. The old "only 6000 chars reach the
# prompt" argument reasoned about the *extracted* body and never justified a raw-HTML cap. 2MB remains a
# finite DoS bound, and the extraction regexes stay linear at it (constant work per candidate, above).
MAX_ARTICLE_SIZE = 2_097_152
# 기사 조회는 압축을 요청하지 않는다: 압축 해제 폭탄(작은 본문이 GB로 부푸는 응답)이 크기 상한을
# 우회하지 못하게 한다. 오리진이 이를 무시해도 스트리밍 카운터가 상한에서 읽기를 끊고, 압축 해제
# 자체가 아래 `DECOMPRESS_STEP` 단위로 묶인다.
# Article fetches ask for no compression, so a decompression bomb (a tiny body inflating to gigabytes)
# cannot slip past the size cap. Should an origin ignore it, the streaming counter still stops at the cap
# and the inflation itself is bounded per `DECOMPRESS_STEP` (below).
IDENTITY_ENCODING = {"Accept-Encoding": "identity"}

# 압축 해제 1스텝의 출력 상한 (바이트). `zlib.decompressobj().decompress(data, max_length=...)`는 이보다
# 큰 출력을 한 번에 만들지 않으므로, **압축률과 무관하게** 스텝 하나의 추가 메모리가 이 값으로 묶인다.
# 왜 필요한가 (2026-08-04 적대적 리뷰 F4): 옛 구현은 httpx가 압축을 풀어 준 `aiter_bytes()`를 읽었다.
# 크기 카운터는 정상 동작했지만 버퍼 최대치가 "캡 + 청크 1개"이고, 그 1개가 작지 않다 — httpcore는
# 원시 본문을 64KB씩 읽고 deflate는 최대 ~1029:1로 부푼다. 실측 결과 청크 하나가 67,395,880바이트,
# 요청 1건의 tracemalloc peak 148.6MB였다(프로세스 maxrss 437MB). 캡을 낮춰도 이 항은 그대로 남는다
# (캡과 무관하게 청크 1개가 지배). 그래서 원시 스트림을 읽고 압축 해제를 스텝 단위로 자른다.
# 이는 가드의 **강화**다 (캡·경고·charset 화이트리스트·데드라인은 그대로, 완화 없음).
# Output bound (bytes) for a single decompression step. `zlib.decompressobj().decompress(data,
# max_length=...)` never produces more than this at once, so one step's extra memory is bounded
# *independently of the compression ratio*.
# Why it is needed (adversarial review F4, 2026-08-04): the old implementation read `aiter_bytes()`, which
# hands over chunks httpx has already decompressed. The size counter worked, but peak buffering was
# "cap + one chunk" and one chunk is not small - httpcore reads the raw body 64KB at a time and deflate
# inflates by up to ~1029:1. A single measured chunk was 67,395,880 bytes with a 148.6MB tracemalloc peak
# for one request (process maxrss 437MB). Lowering the cap does not help: that term dominates at any cap.
# Hence the raw stream is read and the inflation is sliced into steps. This *strengthens* the guard - the
# cap, the warning, the charset whitelist and the deadline all stay exactly as they were.
DECOMPRESS_STEP = 65_536

# 스텝 상한을 걸 수 있는 content-encoding 값 / content-encoding values whose inflation can be bounded
IDENTITY_ENCODINGS = {"", "identity"}
GZIP_ENCODINGS = {"gzip", "x-gzip"}
DEFLATE_ENCODINGS = {"deflate"}


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
    clean = _HTML_TAG_RE.sub("", text)          # HTML 태그 제거 / remove HTML tags
    clean = _HTML_ENTITY_RE.sub(" ", clean)     # HTML 엔티티 제거 / remove HTML entities
    clean = _WHITESPACE_RE.sub(" ", clean)      # 연속 공백 정리 / collapse whitespace
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
        list[NewsItem] - title이 없는 항목은 건너뛴다. 깨진 XML과 적대적 XML은 경고 후 빈 리스트.
        list[NewsItem]; items without a title are skipped, broken and hostile XML warn and yield [].
    """
    items: list[NewsItem] = []
    language = "ko" if is_korean else "en"

    try:
        root = xml_fromstring(xml_text)
    except (DefusedXmlException, ParseError) as exc:
        # DefusedXmlException = 적대적 피드(엔티티 폭탄/XXE), ParseError = 단순 깨진 XML
        # DefusedXmlException marks a hostile feed (entity bomb, XXE); ParseError is plain malformed XML
        _warn("news_rss_parse_failed", source=source,
              error_type=type(exc).__name__, error=str(exc))
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

def _paragraph_bodies(html: str):
    """
    `<p>`/`</p>` 태그를 한 번만 훑어 단락 본문을 순서대로 내놓는다 / Yield paragraph bodies from a single pass over the tags.

    정규식이 태그 짝을 맞추게 하지 않고(`(.*?)</p>` = 이차 스캔의 근원) 태그 목록을 상태 기계로 짝짓는다.
    본문 길이에는 상한을 두지 않는다: 문서 자체가 `MAX_ARTICLE_SIZE`로 제한되고 스캔이 한 번뿐이라
    성능상 필요가 없으며, 기사 전체가 `<p>` 하나인 실제 사이트가 존재하므로 긴 단락을 버리면
    추출이 실패한다.
    The regex no longer pairs the tags (`(.*?)</p>` is what made it quadratic); a state machine pairs the
    tag stream instead. Body length is deliberately unbounded: the document is already capped at
    `MAX_ARTICLE_SIZE` and the scan happens once, so no bound is needed for performance, while real sites
    do put an entire article in a single `<p>` - dropping long bodies would break extraction.

    짝이 맞지 않는 태그는 옛 정규식과 같은 방식으로 처리한다: 여는 태그가 이미 열려 있으면 무시하고
    (`<p>a<p>b</p>` -> 본문 `a<p>b`), 짝 없는 닫는 태그도 무시한다.
    Unpaired tags behave as the old regex did: an opening tag while one is already open is ignored
    (`<p>a<p>b</p>` -> body `a<p>b`), and an unmatched closing tag is ignored.
    """
    open_at = None
    for tag in _P_TAG_RE.finditer(html):
        if tag.group().startswith("</"):
            if open_at is not None:
                yield html[open_at:tag.start()]
                open_at = None
        elif open_at is None:
            open_at = tag.end()


def _body_window(html: str, start: int, closing: str = "") -> str:
    """
    `start`부터 닫는 태그까지, 없으면 고정 창까지 잘라 낸다 / Slice from `start` to the closing tag, else to the fixed window.

    닫는 태그는 정규식이 아니라 `str.find`로 창 안에서만 찾는다 (C 레벨 검색 + 위치당 상한).
    The closing tag is located with `str.find` inside the window only - a C-level search with a bounded span.
    """
    stop = start + ARTICLE_BODY_WINDOW
    if closing:
        end = html.find(closing, start, stop)
        if end != -1:
            return html[start:end]
    return html[start:stop]


def _paragraphs(html: str, min_len: int, drop_boilerplate: bool = False) -> list[str]:
    """<p> 태그 본문을 정리해 최소 길이 이상만 남긴다 / Clean <p> bodies, keeping those above the minimum length."""
    kept = []
    for raw in _paragraph_bodies(html):
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

    1. 첫 `<article>` 시작 태그 뒤 `</article>`까지(없으면 고정 창) 안의 `<p>` (가장 신뢰할 수 있다)
       / `<p>` between the first `<article>` opening tag and `</article>` (or the fixed window when it is
       absent) - the most reliable source.
    2. 대표적인 본문 CSS 클래스 `<div>` **시작 태그 뒤 고정 창** 안의 `<p>` / `<p>` inside a fixed window
       after a well-known article-body `<div>`'s opening tag.
    3. 페이지 전체 `<p>` + 광고·약관 필터 (마지막 폴백) / every `<p>` on the page with an ad/boilerplate filter.

    CPU 바운드 순수 함수다 (정규식 스캔). 이벤트 루프를 막지 않도록 호출부에서
    `asyncio.to_thread`로 감싼다.
    A CPU-bound pure function (regex scanning); callers wrap it in `asyncio.to_thread` so it cannot
    block the event loop.
    """
    # 전략 1 / Stage 1
    article_open = _ARTICLE_OPEN_RE.search(html)
    if article_open:
        found = _paragraphs(
            _body_window(html, article_open.end(), ARTICLE_CLOSE_TAG), MIN_PARAGRAPH_LEN,
        )
        if found:
            return found

    # 전략 2 - 닫는 태그를 찾지 않고 시작 태그 뒤 고정 창만 훑는다 (선형 + 중첩 div 안전)
    # Stage 2 - no closing-tag search: scan a fixed window after the opening tag (linear, nesting-safe)
    for pattern in _BODY_CLASS_RES:
        opening = pattern.search(html)
        if opening:
            # 닫는 `</div>`는 찾지 않는다: 중첩 div가 흔해서 첫 `</div>`는 본문의 끝이 아니다
            # No `</div>` search: nested divs are common, so the first one is not the body's end
            found = _paragraphs(_body_window(html, opening.end()), MIN_PARAGRAPH_LEN)
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


class _BoundedInflater:
    """
    응답 본문을 `DECOMPRESS_STEP` 단위로 압축 해제하는 상태 기계 / A state machine inflating a body in `DECOMPRESS_STEP` steps.

    `zlib.decompressobj.decompress(data, max_length)`는 출력이 상한에 닿으면 멈추고 **남은 입력**을
    `unconsumed_tail`에 남긴다. 그 꼬리를 다음 스텝의 입력으로 되먹이면, 원시 청크가 얼마나 부풀든
    한 번의 해제가 만드는 바이트는 상한 이하로 유지된다 (F4의 핵심).
    `zlib.decompressobj.decompress(data, max_length)` stops once the output reaches the bound and leaves the
    *remaining input* in `unconsumed_tail`. Feeding that tail back as the next step's input keeps any single
    inflation at or below the bound, no matter how much the raw chunk expands - the heart of the F4 fix.
    """

    def __init__(self, encoding: str) -> None:
        self._gzip = encoding in GZIP_ENCODINGS
        self._zobj: Optional[Any] = None   # 첫 청크를 봐야 wbits를 정할 수 있다 / wbits needs the first chunk

    def feed(self, data: bytes) -> Iterator[bytes]:
        """원시 청크 1개를 상한 이하 조각들로 풀어 낸다 / Inflate one raw chunk into pieces of at most `DECOMPRESS_STEP`."""
        if not data:
            # 빈 청크로는 wbits를 정할 수 없다 (첫 바이트가 필요하다) - 상태를 만들지 않고 넘긴다
            # An empty chunk cannot decide wbits (the first bytes are needed), so no state is created
            return
        if self._zobj is None:
            self._zobj = zlib.decompressobj(self._wbits(data))
        while data:
            piece = self._zobj.decompress(data, DECOMPRESS_STEP)
            if not piece:
                # 출력이 없다 = 입력이 모두 내부 상태로 들어갔다 (헤더/부분 블록) -> 다음 청크를 기다린다
                # No output means the input went entirely into internal state (header or partial block)
                return
            yield piece
            # 상한에 걸려 남은 **입력**이 다음 스텝의 입력이 된다 / the input left over by the bound feeds the next step
            data = self._zobj.unconsumed_tail

    def _wbits(self, first_chunk: bytes) -> int:
        """
        첫 청크로 zlib 창 크기를 정한다 / Pick the zlib window size from the first chunk.

        deflate는 실사용에서 zlib 래퍼(RFC 1950)와 헤더 없는 raw(RFC 1951)가 모두 돌아다니므로 첫 2바이트의
        zlib 헤더 검사식으로 고른다. httpx처럼 "zlib으로 시도하고 실패하면 raw로 재시도"는 스텝 단위
        해제에서 성립하지 않는다 - 이미 내보낸 조각을 되돌릴 수 없다.
        Real-world `deflate` arrives both zlib-wrapped (RFC 1950) and header-less (RFC 1951), so the zlib
        header check on the first two bytes decides. httpx's "try zlib, retry raw on error" cannot work with
        stepped inflation, because pieces already emitted cannot be taken back.
        """
        if self._gzip:
            return 16 + zlib.MAX_WBITS       # gzip 헤더 / gzip header
        header_ok = (
            len(first_chunk) >= 2
            and first_chunk[0] & 0x0F == 8                          # CM = 8 (deflate)
            and ((first_chunk[0] << 8) + first_chunk[1]) % 31 == 0   # FCHECK
        )
        return zlib.MAX_WBITS if header_ok else -zlib.MAX_WBITS


async def _limited_text(response: httpx.Response, url: str) -> str:
    """
    크기·메모리 상한을 적용하며 본문을 스트리밍으로 읽어 문자열로 / Stream the body under the size and memory bounds, then decode it.

    본문을 한 번에 메모리에 올리지 않는다(`response.text`/`.read()` 금지): 압축 해제 폭탄이면
    선언된 content-length는 압축 크기라서 상한 검사를 통과하고, 본문 전체를 버퍼링하는 순간
    OOM으로 워커가 죽는다. 그래서 청크마다 누적 바이트를 세고 상한을 넘으면 즉시 읽기를 끊는다.
    The body is never materialized in one go (no `response.text`/`.read()`): with a decompression bomb the
    declared content-length is the *compressed* size, so it passes the cap check and buffering the whole
    body would OOM the worker. Instead every chunk updates a running byte count that breaks out at the cap.

    선언된 content-length는 **읽지 않는다** (정정 2026-08-03): 옛 사전 필터는 상한 초과 선언을 전면
    거부해, 큰 페이지를 정직하게 선언하는 실사이트의 기사 분석을 전멸시켰다 — 같은 페이지가
    chunked면 잘라서 진행했으니 비일관이기도 했다. 방어는 아래 스트리밍 카운터 하나로 충분하다.
    The declared content-length is **ignored** (corrected 2026-08-03): the old pre-filter hard-rejected
    oversized declarations, killing article analysis for real sites that declare big pages honestly —
    while the same page sent chunked was truncated and processed. The streaming counter below is the
    whole defense.

    버퍼링 상한은 "상한 + 압축 해제 스텝 1개"다 (2026-08-04 리뷰 F4로 강화). 그래서 httpx가 풀어 준
    `aiter_bytes()`가 아니라 **원시** 스트림 `aiter_raw()`를 읽고, 압축 해제를 `DECOMPRESS_STEP`
    단위로 잘라 우리가 수행한다 - 옛 경로의 버퍼 상한은 "상한 + 청크 1개"였고 그 1개가 원시 64KB
    읽기의 압축 해제분(최대 ~1029:1, 실측 67MB)이었다. 상한을 낮춰도 남는 항이라 캡만으로는 못 막는다.
    Peak buffering is "the cap plus one decompression step" (strengthened by review F4, 2026-08-04). That is
    why the *raw* stream (`aiter_raw()`) is read instead of httpx's already-decompressed `aiter_bytes()`, and
    the inflation is done here in `DECOMPRESS_STEP` slices: the old path's bound was "cap plus one chunk",
    where one chunk was a raw 64KB read's decompressed expansion (up to ~1029:1, 67MB measured) - a term the
    cap cannot bound at any value.

    스텝 상한을 걸 수 없는 코덱(brotli/zstd 등)은 무한 폴백 대신 거부한다: 스트리밍 디코더에 출력
    상한 인자가 없으므로 한 번의 해제가 압축률만큼 부풀 수 있다 (= F4가 고친 형태 그대로).
    기사 1건을 잃는 것이 워커 메모리를 잃는 것보다 낫다.
    A codec whose steps cannot be bounded (brotli, zstd, ...) is refused rather than decoded unbounded: their
    streaming decoders take no output bound, so one inflate can expand by the full ratio - exactly the shape
    F4 fixed. Losing one article beats losing the worker's memory.

    Returns:
        상한까지의 본문 문자열 (초과분은 잘리고 `article_truncated`로 남는다). 처리할 수 없는
        content-encoding이면 `article_encoding_unsupported` 경고 후 "".
        The body text up to the cap; any excess is cut and logged as `article_truncated`. An unusable
        content-encoding warns as `article_encoding_unsupported` and yields "".
    """
    encoding = (response.headers.get("content-encoding") or "").strip().lower()
    if encoding in IDENTITY_ENCODINGS:
        inflater = None      # 원시 바이트가 그대로 본문이다 / the raw bytes are the body
    elif encoding in GZIP_ENCODINGS or encoding in DEFLATE_ENCODINGS:
        inflater = _BoundedInflater(encoding)
    else:
        _warn("article_encoding_unsupported", url=url, encoding=encoding)
        return ""

    chunks: list = []
    total = 0
    truncated = False
    # `aiter_raw()`는 압축을 풀지 않는다 - 해제는 위 스텝 상한 아래에서 이루어진다 (`aiter_bytes()` 금지)
    # `aiter_raw()` performs no decoding; inflation happens under the step bound above (never `aiter_bytes()`)
    async for raw in response.aiter_raw():
        for piece in (inflater.feed(raw) if inflater is not None else (raw,)):
            chunks.append(piece)
            total += len(piece)
            if total > MAX_ARTICLE_SIZE:
                truncated = True
                break
        if truncated:
            break

    if truncated:
        _warn("article_truncated", url=url, read_bytes=total)

    body = b"".join(chunks)
    # 조각 리스트를 즉시 놓아준다: join 결과와 이중으로 살아 있으면 peak가 캡의 2배가 된다
    # Release the piece list at once: holding it alongside the joined copy doubles the peak
    chunks.clear()
    if len(body) > MAX_ARTICLE_SIZE:
        body = body[:MAX_ARTICLE_SIZE]
    # charset은 화이트리스트를 거친다 (위 `SAFE_CHARSETS` 참조 — 적대적 charset의 O(n²) 코덱 차단)
    # The charset goes through the whitelist (`SAFE_CHARSETS` above — blocks hostile O(n²) codecs)
    charset = (response.charset_encoding or "utf-8").lower()
    if charset not in SAFE_CHARSETS:
        _warn("article_charset_ignored", url=url, charset=charset)
        charset = "utf-8"
    # 상한에서 자르면 멀티바이트 문자가 쪼개질 수 있다 -> 대체 문자로 흡수한다 (본문은 어차피 잘렸다)
    # Cutting at the cap can split a multi-byte character; replacement absorbs it (the body is cut anyway)
    return body.decode(charset, errors="replace")


async def _fetch_hop(client: httpx.AsyncClient, url: str) -> tuple:
    """
    리다이렉트 한 홉을 스트리밍으로 조회 / Fetch one redirect hop as a stream.

    Returns:
        `(next_url, body)` - 리다이렉트면 `(다음 URL, None)`, 최종 응답이면 `(None, 본문)`,
        실패·거부면 `(None, None)`.
        `(next_url, body)`: a redirect yields `(next URL, None)`, a final response `(None, body)`,
        and a failure or rejection `(None, None)`.
    """
    try:
        async with client.stream("GET", url, headers=IDENTITY_ENCODING) as response:
            if response.status_code in REDIRECT_STATUSES:
                location = response.headers.get("location", "")
                if location:
                    return urljoin(url, location), None

            if response.status_code != 200:
                _warn("article_fetch_failed", url=url, status=response.status_code)
                return None, None
            return None, await _limited_text(response, url)
    except Exception as exc:
        _warn("article_fetch_failed", url=url, error=str(exc))
        return None, None


async def _fetch_html(url: str) -> Optional[str]:
    """
    기사 HTML 조회 - 총 데드라인 안에서 리다이렉트를 직접 따라간다 / Fetch article HTML under a total deadline, following redirects manually.

    URL이 클라이언트에서 오므로 매 홉마다 `_is_safe_url`을 다시 실행한다 (리다이렉트로 내부망을
    훑는 것을 막는다). 전체는 `FETCH_TOTAL_DEADLINE`으로 묶는다 — httpx의 read당 타임아웃만으로는
    trickle 오리진이 버퍼를 무기한 잡을 수 있다. 실패·거부·초과는 모두 경고 + None.
    The URL is client-supplied, so `_is_safe_url` re-runs on every hop, which stops redirect chains
    from probing the internal network. The whole fetch sits under `FETCH_TOTAL_DEADLINE`: httpx's
    per-read timeout alone lets a trickling origin hold buffers indefinitely. Failures, rejections
    and the deadline all warn and return None.
    """
    try:
        return await asyncio.wait_for(_fetch_html_hops(url), timeout=FETCH_TOTAL_DEADLINE)
    except asyncio.TimeoutError:
        _warn("article_fetch_timeout", url=url, deadline_seconds=FETCH_TOTAL_DEADLINE)
        return None


async def _fetch_html_hops(url: str) -> Optional[str]:
    """`_fetch_html`의 홉 루프 본체 (데드라인 래퍼와 분리) / The hop loop of `_fetch_html`, split from the deadline wrapper."""
    target = url
    async with _client(follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            if not await _is_safe_url(target):
                return None

            next_target, body = await _fetch_hop(client, target)
            if next_target is None:
                return body
            target = next_target

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

    # 추출은 CPU 바운드 정규식 스캔이다 - 이벤트 루프 밖(스레드)에서 돌린다
    # Extraction is a CPU-bound regex scan, so it runs off the event loop in a thread
    paragraphs = await asyncio.to_thread(_extract_paragraphs, html)
    if not paragraphs:
        _warn("article_extract_failed", url=url)
        return ""
    return "\n\n".join(paragraphs[:MAX_PARAGRAPHS])
