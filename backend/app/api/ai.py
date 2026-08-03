"""
AI 라우트 - Bedrock 종목/기사 분석. 비용이 드는 유일한 엔드포인트라 3중 방어를 건다.
AI routes - Bedrock stock and article analysis. The only endpoints that cost money, so they are
defended three ways.

요청 처리 순서(스펙 그대로): ① IP 레이트리밋(분당 `AI_RATE_PER_MIN`회) → ② 결과 캐시(`AI_TTL`)
→ ③ 전역 동시 실행 제한(`AI_GLOBAL_CONCURRENCY`) 안에서 Bedrock 호출.
Request order (exactly as specified): (1) per-IP rate limit (`AI_RATE_PER_MIN`/min), (2) result cache
(`AI_TTL`), (3) the Bedrock call inside the global concurrency cap (`AI_GLOBAL_CONCURRENCY`).
레이트리밋이 캐시보다 앞이라 캐시 히트도 예산을 소비한다 (한 IP가 무한히 폴링하지 못하게 한다).
The limit precedes the cache, so even a cache hit spends budget: one IP cannot poll without bound.

오류 본문은 항상 고정 문구다 - 예외 문자열에는 AWS 계정/ARN/모델 ID가 섞일 수 있어 클라이언트로
내보내지 않고 서버 로그에만 남긴다.
Error bodies are always fixed strings: exception text can carry an AWS account, ARN or model id, so it
goes to the server log only, never to the client.

동기 함수(boto3, `analyze_*`)는 `asyncio.to_thread`로 감싼다 (이벤트 루프 블로킹 금지).
The synchronous functions (boto3-backed `analyze_*`) run through `asyncio.to_thread`.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any, Awaitable, Callable, List, Literal, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.api import deps, stocks
from app.api.ratelimit import SlidingWindowLimiter
from app.core import config
from app.models import envelope
from app.services import bedrock_ai, news
from app.state import AppState, STATUS_DEGRADED, STATUS_OK

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ai", tags=["ai"])

# 소스 키 - `state.SOURCE_KEYS`/헬스 응답과 같은 이름 / Source key: the name used in SOURCE_KEYS and the health body
SOURCE_BEDROCK = "bedrock"

# 레이트리밋 윈도우(초) - 429 본문의 retryAfter와 같은 값 / Rate-limit window in seconds; also the 429 body's retryAfter
RATE_WINDOW_SEC = 60

# CloudFront가 생성하는 뷰어 주소 헤더("ip:port") - 레이트리밋 키의 1순위 (위조 불가)
# CloudFront-generated viewer address ("ip:port"): the primary rate-limit key, and unforgeable.
# CDK가 origin request policy에 이 헤더를 화이트리스트로 넣어야 오리진까지 도달한다
# (`infra/stacks/stock_monitoring_stack.py`).
# It only reaches the origin because the CDK origin request policy whitelists it
# (see `infra/stacks/stock_monitoring_stack.py`).
VIEWER_ADDRESS_HEADER = "cloudfront-viewer-address"
RATE_LIMITED_BODY = {"detail": "rate_limited", "retryAfter": RATE_WINDOW_SEC}

# 클라이언트에 내보내는 고정 오류 문구 (예외 문자열은 절대 넣지 않는다)
# Fixed error details sent to clients (an exception string is never one of them)
DETAIL_AI_UNAVAILABLE = "ai_unavailable"        # 503: 자격 증명/모델 접근 불가 / no credentials or model access
DETAIL_AI_FAILED = "ai_failed"                  # 500: 그 외 호출 실패 / any other call failure
DETAIL_ARTICLE_UNAVAILABLE = "article_unavailable"  # 502: 기사 본문을 얻지 못함 / the article body could not be obtained

# 클라이언트 입력 상한 - 프롬프트/캐시 키에 들어가므로 길이를 제한한다
# Caps on client input: it reaches the prompt and the cache key, so its length is bounded
MAX_URL_LEN = 2048
MAX_TITLE_LEN = 512


def _warn(event: str, **fields: Any) -> None:
    """실패를 단일 라인 JSON 경고로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


# ---------------------------------------------------------------------------
# 캐시 키 / Cache keys
# ---------------------------------------------------------------------------

def key_stock_ai(symbol: str) -> str:
    """종목 분석 캐시 키 / Stock analysis cache key."""
    return f"ai:stock:{symbol}"


def key_article_ai(url: str) -> str:
    """기사 분석 캐시 키 - URL sha1 앞 16자 (URL 자체를 키에 넣지 않는다) / Article analysis cache key: first 16 chars of the URL sha1."""
    return f"ai:article:{hashlib.sha1(url.encode()).hexdigest()[:16]}"


# ---------------------------------------------------------------------------
# 요청 본문 / Request body
# ---------------------------------------------------------------------------

class ArticleRequest(BaseModel):
    """
    기사 분석 요청 본문 / Article analysis request body.

    Attributes:
        url: 기사 URL (본문은 서버가 직접 조회한다 - SSRF 가드는 `news.fetch_article_content`에 있다)
            / Article URL; the server fetches the body itself (SSRF guards live in `news.fetch_article_content`).
        title: 기사 제목 (프롬프트에 들어간다) / Article title (goes into the prompt).
        language: `ko`면 요약·분석만, `en`이면 한국어 번역까지 / `ko` summarizes; `en` also asks for a Korean translation.
    """

    url: str = Field(min_length=1, max_length=MAX_URL_LEN)
    title: str = Field(min_length=1, max_length=MAX_TITLE_LEN)
    language: Literal["ko", "en"]


# ---------------------------------------------------------------------------
# 레이트리밋 / Rate limiting
# ---------------------------------------------------------------------------

def viewer_ip(viewer_address: str) -> str:
    """
    `CloudFront-Viewer-Address`("ip:port")에서 IP만 떼어낸다 / Take the IP out of `CloudFront-Viewer-Address` ("ip:port").

    IPv6 주소 자체가 콜론을 포함하므로 **마지막 콜론**에서만 자른다 (`2001:db8::1:53210` -> `2001:db8::1`).
    대괄호로 감싼 형태도 받아 준다.
    An IPv6 address contains colons itself, so only the *last* colon splits off the port
    (`2001:db8::1:53210` -> `2001:db8::1`). A bracketed form is accepted too.

    Returns:
        IP 문자열, 값이 비어 있으면 "" / The IP string, or "" when the value is empty.
    """
    address = viewer_address.strip()
    if not address:
        return ""
    head, colon, _port = address.rpartition(":")
    return (head if colon else address).strip().strip("[]")


def client_ip(request: Request) -> str:
    """
    레이트리밋 기준 IP / The IP the rate limit keys on.

    **`CloudFront-Viewer-Address`를 우선한다.** 이 헤더는 CloudFront가 TCP 연결에서 직접 만들어
    붙이는 값이라 뷰어가 위조할 수 없다 (뷰어가 같은 이름을 보내도 CloudFront가 덮어쓴다).
    반면 `X-Forwarded-For`의 첫 항목은 클라이언트가 임의로 채워 넣을 수 있고 CloudFront는 그 뒤에
    실제 IP를 덧붙이기만 하므로, 첫 항목을 키로 쓰면 요청마다 다른 값을 보내 한도를 무한히 우회할 수
    있다 (2026-08-02 라이브 실증 -> 사용자 결정).
    **`CloudFront-Viewer-Address` wins.** CloudFront generates it from the TCP connection, so a viewer
    cannot forge it (a viewer-supplied header of the same name is overwritten). The first
    `X-Forwarded-For` entry, by contrast, is whatever the client wrote: CloudFront only appends the real
    address behind it, so keying on the first entry lets a caller rotate the value per request and evade
    the limit entirely (demonstrated live on 2026-08-02, hence the ruling).

    폴백은 기존 XFF 첫 항목 -> 소켓 주소 순서다. CloudFront를 거치지 않는 로컬 개발/직접 호출에서만
    쓰이며, 그 환경에는 위조 위험이 없다.
    The fallback chain stays "first XFF entry, then the socket address". It only applies off CloudFront
    (local development, direct calls), where forgery is not a concern.

    비용 방어는 이 한도 하나에 기대지 않는다 - 결과 캐시와 전역 동시 실행 제한이 함께 상한을 만든다.
    Cost defense still does not rest on this limit alone: the result cache and the global concurrency cap
    bound it as well.
    """
    viewer = viewer_ip(request.headers.get(VIEWER_ADDRESS_HEADER, ""))
    if viewer:
        return viewer

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


def get_limiter(request: Request) -> SlidingWindowLimiter:
    """
    앱 단위 리미터 (첫 요청에서 생성) / The app-wide limiter, created on first use.

    앱 인스턴스에 붙여 두므로 프로세스 전역 상태가 없다 (테스트마다 새 앱 = 새 예산).
    It hangs off the app instance, so there is no process-global state (a new app means a new budget).
    """
    limiter = getattr(request.app.state, "ai_limiter", None)
    if limiter is None:
        limiter = SlidingWindowLimiter(config.AI_RATE_PER_MIN, RATE_WINDOW_SEC)
        request.app.state.ai_limiter = limiter
    return limiter


def get_semaphore(request: Request) -> asyncio.Semaphore:
    """
    Bedrock 전역 동시 실행 세마포어 (첫 요청에서 생성) / The global Bedrock concurrency semaphore, created on first use.

    임포트 시점에 만들지 않는다: Python 3.9의 asyncio 프리미티브는 생성 시점의 이벤트 루프에
    묶이므로, 실행 중인 루프 안(=요청 처리 중)에서 만들어야 한다.
    Never created at import time: on Python 3.9 an asyncio primitive binds the event loop it is created
    on, so it must be built inside the running loop (that is, while handling a request).
    """
    semaphore = getattr(request.app.state, "ai_semaphore", None)
    if semaphore is None:
        semaphore = asyncio.Semaphore(config.AI_GLOBAL_CONCURRENCY)
        request.app.state.ai_semaphore = semaphore
    return semaphore


def get_fetch_semaphore(request: Request) -> asyncio.Semaphore:
    """
    기사 본문 fetch 전용 세마포어 (첫 요청에서 생성) / The article-fetch semaphore, created on first use.

    Bedrock 세마포어와 **분리**되어 있다 (2026-08-03 보안 리뷰): 하나를 같이 쓰면 느린 fetch가
    Bedrock 예산을 잠식해 IP 2개로 AI 기능 전체가 대기열에 갇힌다. 늦은 생성 이유는
    `get_semaphore`와 같다 (asyncio 프리미티브는 실행 중인 루프에서 만든다).
    Kept **separate** from the Bedrock semaphore (security review 2026-08-03): shared, slow fetches
    would starve the Bedrock budget and two IPs could queue-lock every AI feature. Created lazily for
    the same reason as `get_semaphore` (asyncio primitives are built on the running loop).
    """
    semaphore = getattr(request.app.state, "ai_fetch_semaphore", None)
    if semaphore is None:
        semaphore = asyncio.Semaphore(config.AI_FETCH_CONCURRENCY)
        request.app.state.ai_fetch_semaphore = semaphore
    return semaphore


def rate_limited(request: Request) -> Optional[JSONResponse]:
    """
    한도 초과면 429 응답, 통과면 None / A 429 response when over the limit, None when allowed.

    본문은 스펙 고정값 `{"detail": "rate_limited", "retryAfter": 60}`이며 `Retry-After` 헤더도 같이 준다.
    The body is the specified `{"detail": "rate_limited", "retryAfter": 60}`, plus a `Retry-After` header.
    """
    ip = client_ip(request)
    if get_limiter(request).allow(ip):
        return None
    _warn("ai_rate_limited", ip=ip, path=request.url.path, limit=config.AI_RATE_PER_MIN)
    return JSONResponse(
        status_code=429,
        content=RATE_LIMITED_BODY,
        headers={"Retry-After": str(RATE_WINDOW_SEC)},
    )


# ---------------------------------------------------------------------------
# Bedrock 호출 + 결과 캐시 / Bedrock call and result cache
# ---------------------------------------------------------------------------

async def invoke_bedrock(
    state: AppState,
    semaphore: asyncio.Semaphore,
    call: Callable[[], str],
) -> str:
    """
    전역 동시 실행 제한 안에서 동기 Bedrock 함수를 실행 / Run a synchronous Bedrock function inside the global concurrency cap.

    성공/실패를 모두 `bedrock` 소스 상태에 반영한다 (조용한 실패 금지).
    Both outcomes are reflected in the `bedrock` source status (no silent failures).

    Args:
        state: 앱 컨텍스트 / App context.
        semaphore: 전역 동시 실행 세마포어 / The global concurrency semaphore.
        call: 인자가 없는 동기 호출 (`analyze_stock`/`analyze_article` 부분 적용) / Zero-argument sync call.

    Returns:
        마크다운 분석 텍스트 / The markdown analysis text.

    Raises:
        BedrockUnavailableError, BedrockCallError: 서비스 계층의 타입 있는 예외 그대로 / the service's typed errors, unchanged.
    """
    async with semaphore:
        try:
            text = await asyncio.to_thread(call)
        except Exception as exc:
            state.mark_source(SOURCE_BEDROCK, STATUS_DEGRADED)
            _warn("ai_bedrock_failed", error=str(exc), error_type=type(exc).__name__)
            raise
    state.mark_source(SOURCE_BEDROCK, STATUS_OK)
    return text


async def cached_analysis(
    state: AppState,
    key: str,
    build: Callable[[], Awaitable[dict]],
) -> Tuple[dict, str]:
    """
    캐시(L1 -> L2)를 먼저 보고, 미스일 때만 `build`로 분석을 생성 / Read the cache (L1 -> L2) and only build on a miss.

    `deps.cached`를 쓰지 않는다: 그 래퍼는 모든 실패를 503 하나로 뭉개서 503/500/502 구분과
    고정 오류 문구를 만들 수 없다. 대신 계층 캐시를 직접 호출한다 - 같은 키의 동시 요청은
    `TieredCache`의 키별 락으로 한 번만 Bedrock을 호출한다 (비용 방어).
    `deps.cached` is not used: it collapses every failure into one 503, which would lose the 503/500/502
    split and the fixed error details. Calling the tiered cache directly also keeps its per-key lock, so
    concurrent requests for one key trigger a single Bedrock call.

    Returns:
        (분석 데이터 dict, asOf ISO8601) / (analysis data dict, asOf ISO8601).

    Raises:
        HTTPException: 503 `ai_unavailable`(자격 증명/접근), 500 `ai_failed`(그 외), 그리고 `build`가
            올린 HTTPException은 상태 코드를 유지한 채 통과 / 503 `ai_unavailable` (credentials or access),
            500 `ai_failed` (anything else); an HTTPException raised by `build` passes through unchanged.
    """
    try:
        data, as_of, _origin = await state.cache.get_or_fetch(key, config.AI_TTL, build)
    except HTTPException:
        # `build`가 정한 상태 코드를 다시 매핑하지 않는다 (502가 500으로 뒤바뀌면 안 된다)
        # Never remap a status code `build` already chose (a 502 must not turn into a 500)
        raise
    except bedrock_ai.BedrockUnavailableError as exc:
        _warn("ai_unavailable", key=key, error=str(exc))
        raise HTTPException(status_code=503, detail=DETAIL_AI_UNAVAILABLE) from exc
    except Exception as exc:
        # BedrockCallError(잘못된 입력·응답 해석 실패)와 예기치 못한 오류를 함께 500으로 매핑한다
        # BedrockCallError (bad input, unreadable response) and unexpected errors both map to 500
        _warn("ai_failed", key=key, error=str(exc), error_type=type(exc).__name__)
        raise HTTPException(status_code=500, detail=DETAIL_AI_FAILED) from exc
    return data, as_of


async def recent_news_titles(state: AppState, symbol: str) -> List[str]:
    """
    프롬프트 보강용 최근 뉴스 제목 / Recent news titles that enrich the prompt.

    뉴스는 분석의 부가 입력이라 실패해도 분석을 계속한다 (`deps.cached`가 이미 로그를 남기고
    `rss` 소스 상태를 degraded로 표시한 뒤 503을 올린다 - 여기서 삼키는 것은 그 503뿐이다).
    News is an optional input, so a failure must not abort the analysis. `deps.cached` has already logged
    it and marked the `rss` source degraded before raising the 503 that is swallowed here.
    """
    try:
        items, _as_of = await deps.cached(
            state,
            deps.key_news(symbol),
            config.L2_TTL,
            lambda: stocks.company_news_payload(symbol),
            deps.SOURCE_RSS,
        )
    except HTTPException:
        _warn("ai_news_titles_unavailable", symbol=symbol)
        return []
    return [item["title"] for item in items if isinstance(item, dict) and item.get("title")]


# ---------------------------------------------------------------------------
# 라우트 / Routes
# ---------------------------------------------------------------------------

@router.post("/stocks/{symbol}")
async def post_stock_analysis(
    request: Request,
    symbol: str = Depends(deps.resolve_symbol),
    state: AppState = Depends(deps.get_state),
) -> Any:
    """
    종목 AI 분석 (한국어 마크다운) / AI stock analysis as Korean markdown.

    본문은 없다. 프롬프트 입력(가격/PER/52주/섹터/뉴스 제목)은 이미 캐시된 상세·종목뉴스에서 가져오므로
    AI 요청이 yfinance/RSS를 새로 때리는 일은 보통 없다.
    There is no request body. The prompt inputs (price, P/E, 52-week range, sector, news titles) come from
    the already-cached detail and per-symbol news, so an AI request rarely hits yfinance or RSS.

    Returns:
        `{"asOf", "marketOpen", "data": {"symbol", "analysis"}}` - 한도 초과 시에는 429 JSONResponse.
        The envelope above, or a 429 JSONResponse when the caller is over its limit.
    """
    limited = rate_limited(request)
    if limited is not None:
        return limited
    semaphore = get_semaphore(request)

    async def build() -> dict:
        # 가격 오버레이가 적용된 상세를 그대로 쓴다 (테이블·헤더·호가와 같은 가격으로 분석한다)
        # The price-overlaid detail is reused, so the analysis sees the same price as the table and header
        detail, _as_of = await stocks.detail_view(state, symbol)
        titles = await recent_news_titles(state, symbol)
        text = await invoke_bedrock(
            state,
            semaphore,
            lambda: bedrock_ai.analyze_stock(
                symbol=symbol,
                name=detail.get("name") or symbol,
                price=float(detail.get("price") or 0.0),
                change_pct=float(detail.get("change_pct") or 0.0),
                pe_ratio=detail.get("pe_ratio"),
                week52_high=float(detail.get("week52_high") or 0.0),
                week52_low=float(detail.get("week52_low") or 0.0),
                sector=detail.get("sector") or "",
                # 프롬프트는 대문자 시장 코드를 쓴다 ("US"/"KR") / The prompt expects an upper-case market code
                market=(detail.get("market") or deps.market_of(symbol)).upper(),
                news_titles=titles,
            ),
        )
        return {"symbol": symbol, "analysis": text}

    data, as_of = await cached_analysis(state, key_stock_ai(symbol), build)
    return envelope(data, deps.market_open_now(), as_of)


@router.post("/articles")
async def post_article_analysis(
    payload: ArticleRequest,
    request: Request,
    state: AppState = Depends(deps.get_state),
) -> Any:
    """
    기사 요약·번역·인사이트 (한국어 마크다운) / Article summary, translation and insights as Korean markdown.

    캐시 키는 URL만으로 만든다(스펙): 같은 URL을 다른 제목으로 다시 요청하면 먼저 생성된 분석이 그대로 나온다.
    The cache key is built from the URL alone (as specified): re-requesting one URL with a different title
    returns the analysis generated first.

    Returns:
        `{"asOf", "marketOpen", "data": {"url", "title", "language", "analysis"}}` - 한도 초과 시 429 JSONResponse.
        The envelope above, or a 429 JSONResponse when the caller is over its limit.
    """
    limited = rate_limited(request)
    if limited is not None:
        return limited
    semaphore = get_semaphore(request)
    fetch_semaphore = get_fetch_semaphore(request)

    async def build() -> dict:
        # fetch는 **전용** 세마포어 안에서 돈다 (2026-08-03 보안 리뷰 F2 + 재검증 breakage 1):
        # 캡 상향(2MB) 후 fetch 한 건이 수 MB 버퍼를 잡으므로 동시 fetch 버퍼 누적을
        # AI_FETCH_CONCURRENCY개로 묶는다. Bedrock 세마포어와 분리한 이유: 하나를 같이 쓰면 느린
        # fetch(최대 20s 점유)가 Bedrock 예산을 잠식해 IP 2개로 AI 기능 전체가 대기열에 갇힌다.
        # 이 세마포어는 동시 fetch 버퍼만 묶는다 — Bedrock 호출량은 `invoke_bedrock`의 세마포어가 묶는다.
        # The fetch runs inside its **own** semaphore (security review F2 + re-review breakage 1,
        # 2026-08-03): after the 2MB cap raise one fetch holds multi-MB buffers, so concurrent fetch
        # buffers are capped at AI_FETCH_CONCURRENCY. It is separate from the Bedrock semaphore because
        # sharing one lets slow fetches (holding up to 20s) starve the Bedrock budget — two IPs could
        # queue-lock every AI feature. This semaphore bounds concurrent fetch buffers only; Bedrock
        # volume is bounded by `invoke_bedrock`'s semaphore.
        async with fetch_semaphore:
            content = await news.fetch_article_content(payload.url)
        if not content:
            # 본문이 없으면 분석은 무의미하다: Bedrock을 부르지도, 실패를 캐시하지도 않는다
            # Without a body there is nothing to analyze: no Bedrock call, and no cached failure
            _warn("ai_article_content_empty", url=payload.url)
            raise HTTPException(status_code=502, detail=DETAIL_ARTICLE_UNAVAILABLE)
        text = await invoke_bedrock(
            state,
            semaphore,
            lambda: bedrock_ai.analyze_article(payload.title, content, payload.language == "ko"),
        )
        return {
            "url": payload.url,
            "title": payload.title,
            "language": payload.language,
            "analysis": text,
        }

    data, as_of = await cached_analysis(state, key_article_ai(payload.url), build)
    return envelope(data, deps.market_open_now(), as_of)
