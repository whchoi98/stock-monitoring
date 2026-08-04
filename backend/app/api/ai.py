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

두 엔드포인트는 `text/event-stream`으로 응답한다 (스펙 §2): `phase` -> `delta`* -> `final`. 첫 이벤트는
즉시 나가고 델타마다 CloudFront idle 카운터가 리셋되므로 wall-clock 제약이 사라지며, `final`은 성공이든
실패든 **항상** emit된다. 레이트리밋 429와 422 검증은 스트림 시작 전이라 기존 JSON 응답 그대로다.
Both endpoints answer with `text/event-stream` (spec §2): `phase`, then deltas, then `final`. The first
event leaves immediately and every delta resets the CloudFront idle counter, which removes the wall-clock
ceiling, and a `final` is **always** emitted, success or failure. The 429 rate limit and 422 validation are
decided before the stream starts, so both keep their existing JSON responses.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
from typing import Any, AsyncIterator, Callable, List, Literal, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
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
# SSE 스트림 / SSE streaming
# ---------------------------------------------------------------------------

# 팔로워 하트비트 간격(초) - CloudFront/ALB idle 카운터 리셋용. 테스트가 짧게 monkeypatch한다.
# Follower heartbeat period (seconds), resetting the CloudFront/ALB idle counters; tests shrink it.
HEARTBEAT_SECONDS = 5.0

# 이벤트 이름 (스펙 §2 프로토콜 - 이 셋 외의 이벤트는 없다) / Event names; the protocol has no others
EVENT_PHASE = "phase"
EVENT_DELTA = "delta"
EVENT_FINAL = "final"

# phase 값 / phase values
PHASE_FETCHING = "fetching"      # 기사 본문 조회 중 / fetching the article body
PHASE_ANALYZING = "analyzing"    # Bedrock 스트림 진행 중 / the Bedrock stream is running
PHASE_WAITING = "waiting"        # 같은 키의 선점자를 기다리는 중 / waiting on this key's leader

# inflight Future 결과 태그 / Result tags on an in-flight registry future
OUTCOME_OK = "ok"
OUTCOME_ERROR = "error"

# SSE 응답 헤더 - 캐시 금지 + 프록시 버퍼링 금지 (버퍼링되면 델타가 뭉쳐 스트리밍이 무의미해진다)
# SSE response headers: never cached, never proxy-buffered (buffering would coalesce the deltas)
SSE_HEADERS = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}


def _sse(event: str, data: dict) -> bytes:
    """SSE 프레임 하나 / One SSE frame."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


def get_inflight(request: Request) -> dict:
    """
    진행 중 스트림 레지스트리 (앱 단위, 첫 요청에서 생성) / The per-app in-flight stream registry.

    키 -> Future(`(OUTCOME_OK, data, asOf)` 또는 `(OUTCOME_ERROR, detail, status)`). 같은 키의 두 번째
    요청은 Bedrock을 다시 부르지 않고 이 Future를 기다린다 (블로킹 시절 `TieredCache`의 키별 락이 하던
    비용 방어를, 스트림을 중계할 수 있는 형태로 옮긴 것이다). 선점자가 항상 finally에서 항목을
    제거하므로 클라이언트 URL에서 파생되는 기사 키로도 무한히 자라지 않는다.
    Maps key -> Future(...). A second request for one key waits on that future instead of calling Bedrock
    again: the cost defense the tiered cache's per-key lock used to provide, reshaped so the outcome can
    be relayed to a stream. The leader always pops its entry in a finally, so even article keys derived
    from client URLs cannot grow this map without bound.
    """
    registry = getattr(request.app.state, "ai_inflight", None)
    if registry is None:
        registry = {}
        request.app.state.ai_inflight = registry
    return registry


def _return_permit(semaphore: asyncio.Semaphore, acquire: "asyncio.Future[bool]") -> None:
    """
    획득 태스크가 든 permit을 반납한다 (모든 이탈 경로에서 호출) / Return the permit the acquisition holds, on every exit path.

    세 경우뿐이다. ① 획득 완료(정상 종료·스트림 실패·소비자 이탈) -> `release`. ② 아직 대기 중 ->
    태스크를 취소한다. `asyncio.Semaphore.acquire`는 취소와 permit 부여의 경합까지 스스로 처리하므로
    (취소된 대기자는 값을 되돌려 주고 다음 대기자를 깨운다) 여기서 release하면 오히려 이중 반납이 된다.
    ③ 취소를 걸기도 전에 이미 부여됐다면 태스크가 done이므로 ①로 처리된다.
    Exactly three cases: (1) already acquired (normal end, stream failure, consumer departure) -> release;
    (2) still waiting -> cancel the task, and *do not* release: `asyncio.Semaphore.acquire` itself settles
    the cancel-vs-grant race (a cancelled waiter gives the value back and wakes the next one), so releasing
    here would double-return it; (3) granted just before the cancel lands -> the task is done, so it takes
    path (1).
    """
    if not acquire.done():
        acquire.cancel()
        return
    if not acquire.cancelled() and acquire.exception() is None:
        semaphore.release()


async def _waiting_heartbeats(pending: "asyncio.Future[Any]") -> AsyncIterator[Tuple[str, dict]]:
    """
    `pending`이 끝날 때까지 `HEARTBEAT_SECONDS`마다 `phase: waiting`을 낸다 / Emit `phase: waiting` every `HEARTBEAT_SECONDS` until `pending` settles.

    이 스트림의 **모든** 대기 구간이 쓰는 단 하나의 하트비트 루프다 (선점자의 Bedrock permit 대기,
    기사 fetch permit 대기, 팔로워의 선점자 대기). 대기가 조용하면 첫 phase 뒤로 바이트가 없어
    CloudFront/ALB idle 카운터가 리셋되지 않고 연결이 끊긴다 - SSE로 옮겨 온 이유 자체가 그것이다.
    구현이 한 군데라 간격(과 그 monkeypatch)도 모든 대기에 똑같이 적용된다.
    The one heartbeat loop **every** wait in this stream uses: a leader queued for a Bedrock permit, an
    article request queued for a fetch permit, and a follower waiting on its leader. A silent wait sends no
    bytes after the first phase event, so the CloudFront/ALB idle counters never reset and the connection
    dies - the very reason this feature moved to SSE. With one implementation, the period (and a test's
    monkeypatch of it) applies identically to every wait.

    결과도 예외도 여기서 꺼내지 않는다 - 호출부가 `pending.result()`로 직접 회수한다 (획득 실패는
    호출부의 오류 경로로 올라가야 하고, 팔로워의 Future는 튜플 결과를 그대로 해석해야 한다).
    Neither the result nor an exception is consumed here: the caller harvests it with `pending.result()`,
    because an acquisition failure belongs on the caller's error path and a follower's future carries a
    tuple the caller has to interpret itself.
    """
    while True:
        done, _pending = await asyncio.wait([pending], timeout=HEARTBEAT_SECONDS)
        if done:
            return
        yield (EVENT_PHASE, {"phase": PHASE_WAITING})


async def _permit_wait(
    acquire: "asyncio.Future[bool]",
    phase: str,
    announced: bool,
) -> AsyncIterator[Tuple[str, dict]]:
    """
    permit을 기다리는 동안 하트비트를 내고, 확보 후 진행 단계를 (다시) 알린다.
    Heartbeat while a permit is pending, then (re-)announce the phase that follows it.

    `async with semaphore`를 쓸 수 없는 이유: 대기 중에도 이벤트를 내보내야 하므로 획득이 태스크여야
    한다. 그래서 세마포어의 생성/반납은 호출부가 갖는다 - permit 보유 구간의 길이가 호출부마다 다르다
    (Bedrock permit은 스트림 완료까지, fetch permit은 본문 조회까지). 반납은 호출부의 `finally`에서
    `_return_permit`이 책임진다.
    `async with semaphore` is impossible here: events must flow *during* the wait, so acquisition has to be
    a task. Creating and returning the permit therefore stays with the caller, whose hold differs per site
    (a Bedrock permit is held until the stream ends, a fetch permit only until the body is in). The caller's
    `finally` hands it back through `_return_permit`.

    Args:
        acquire: `asyncio.ensure_future(semaphore.acquire())` - 호출부가 만들고 반납까지 책임진다
            / created by the caller, which also owns returning it.
        phase: permit을 든 뒤 진행할 단계 (`analyzing`/`fetching`) / the phase the work runs in once the permit is held.
        announced: 호출부가 이미 그 phase를 냈는지. True면 **대기가 있었을 때만** 다시 알린다 -
            대기 없는 흐름에 같은 phase를 두 번 내지 않고, 대기가 있었으면 `waiting`이 마지막 phase로
            남지 않게 한다(프론트는 latest-wins로 표시한다).
            / Whether the caller already emitted that phase. When True it is re-announced **only after a
            wait**, so an uncontended flow never repeats a phase while a contended one never leaves
            `waiting` as the latest phase (the frontend renders latest-wins).

    Raises:
        획득 태스크의 예외 그대로 / whatever the acquisition task raised.
    """
    waited = False
    # aclosing: 소비자가 대기 중에 사라지면 하트비트 제너레이터를 GC 시점이 아니라 지금 닫는다
    # aclosing: if the consumer leaves mid-wait, close the heartbeat generator now, not at some GC tick
    async with contextlib.aclosing(_waiting_heartbeats(acquire)) as beats:
        async for event in beats:
            waited = True
            yield event
    acquire.result()    # permit 확보 (획득 실패는 그대로 올린다) / permit in hand; a failure propagates
    if waited or not announced:
        yield (EVENT_PHASE, {"phase": phase})


async def _bedrock_deltas(
    state: AppState,
    semaphore: asyncio.Semaphore,
    make_stream: Callable[[], AsyncIterator[str]],
    analyzing_announced: bool,
) -> AsyncIterator[Tuple[str, dict]]:
    """
    전역 동시 실행 제한 안에서 Bedrock 스트림을 돌리며 phase/delta 이벤트를 흘린다.
    Run a Bedrock stream inside the global concurrency cap, yielding phase and delta events.

    permit은 **스트림 완료까지** 보유한다 - 블로킹 경로가 호출 하나를 감쌌던 것과 같은 동시성 의미다
    (요청 하나가 끝날 때까지 permit 하나). 소비자가 사라지면 `GeneratorExit`이 이 제너레이터를 닫으며
    `finally`가 permit을 반납하고, 서비스 계층이 펌프 스레드를 멈춘다.
    The permit is held until the stream ends - the same concurrency meaning the blocking path had when it
    wrapped one call. If the consumer leaves, `GeneratorExit` closes this generator, the `finally` returns
    the permit, and the service layer stops its pump thread.

    **permit 대기 중에도 `phase: waiting` 하트비트를 낸다** (`_permit_wait`). 상한이
    `AI_GLOBAL_CONCURRENCY`(2)라 뒤늦은 요청은 앞선 두 스트림이 끝날 때까지 수십 초를 기다릴 수
    있는데, 그동안 조용하면 첫 phase 뒤로 바이트가 없어 CloudFront origin-response 타임아웃에 걸린다 -
    이 기능이 없애려는 그 wall-clock 제약이다. `analyzing`은 permit을 든 **뒤에** 알린다 - 대기 중에
    "분석 중"이라고 말하지 않기 위해서다.
    **The permit wait heartbeats `phase: waiting` too** (see `_permit_wait`). With the cap at
    `AI_GLOBAL_CONCURRENCY` (2) a late request can wait tens of seconds for two in-flight streams, and a
    silent wait sends nothing after the first phase event - straight into the CloudFront origin-response
    timeout this feature exists to remove. `analyzing` is announced only *after* the permit is held, so the
    stream never claims to be analyzing while it is queued.

    성공/실패는 모두 `bedrock` 소스 상태에 반영한다 (조용한 실패 금지).
    Both outcomes are reflected in the `bedrock` source status (no silent failures).

    Args:
        analyzing_announced: 호출부가 이미 `phase: analyzing`을 냈는지 (주식 라우트의 첫 이벤트가 그것이다).
            True면 대기가 있었을 때만 다시 알린다 - 대기 없는 흐름에 같은 phase를 두 번 내지 않는다.
            / Whether the caller already emitted `phase: analyzing` (the stock route's first event is
            exactly that). When True it is re-announced only if a wait happened, so an uncontended stream
            never repeats the same phase.

    Raises:
        BedrockUnavailableError, BedrockCallError: 서비스 계층의 타입 있는 예외 그대로 / the service's typed errors, unchanged.
    """
    acquire: "asyncio.Future[bool]" = asyncio.ensure_future(semaphore.acquire())
    try:
        async with contextlib.aclosing(
            _permit_wait(acquire, PHASE_ANALYZING, analyzing_announced)
        ) as permit_events:
            async for event in permit_events:
                yield event

        try:
            # `make_stream()` 호출 자체(프롬프트 조립)도 try 안에 둔다 - 잘못된 입력의 즉시 예외까지 잡는다
            # The call itself (prompt assembly) sits inside the try so an eager bad-input error is caught too
            async for delta in make_stream():
                yield (EVENT_DELTA, {"text": delta})
        except Exception as exc:
            state.mark_source(SOURCE_BEDROCK, STATUS_DEGRADED)
            _warn("ai_bedrock_failed", error=str(exc), error_type=type(exc).__name__)
            raise
        state.mark_source(SOURCE_BEDROCK, STATUS_OK)
    finally:
        _return_permit(semaphore, acquire)


async def _analysis_stream(
    state: AppState,
    inflight: dict,
    key: str,
    first_phase: str,
    produce: Callable[[], AsyncIterator[Tuple[str, dict]]],
    build_data: Callable[[str], dict],
) -> AsyncIterator[bytes]:
    """
    두 AI 라우트가 공유하는 SSE 골격 / The SSE skeleton both AI routes share.

    ① 첫 `phase`를 즉시 emit (TTFB ~0초 - CloudFront idle 카운터 리셋이 곧바로 시작된다)
    ② 캐시 프로브(`peek`): 히트면 `final` 하나로 끝낸다
    ③ 미스면 이 키의 선점자/팔로워를 가른다 - 선점자는 `produce()`의 이벤트를 중계하며 델타를 누적하고
       완료 시 캐시에 저장, 팔로워는 `HEARTBEAT_SECONDS`마다 `phase: waiting`을 내며 선점자 결과를 승계
       (선점자도 Bedrock permit을 기다리는 동안 같은 하트비트를 낸다 - `_bedrock_deltas`)
    ④ **어떤 경로에서도 `final`을 emit한다** - 오류는 `{"error": DETAIL_*, "status": code}`로 실어 보낸다.
       SSE의 최다 운영 이슈(연결만 끊겨 클라이언트가 완료/사망을 구분 못 함)를 여기서 차단한다.
    (1) emit the first `phase` at once, so TTFB is ~0s and the CloudFront idle counter starts resetting;
    (2) probe the cache with `peek` - a hit ends the stream with a single `final`;
    (3) on a miss, split leader from follower: the leader relays `produce()`'s events while accumulating
        deltas and caches the result, a follower heartbeats `phase: waiting` and inherits the outcome
        (a leader queued for a Bedrock permit heartbeats the same way - see `_bedrock_deltas`);
    (4) **every path emits a `final`**, errors carried as `{"error": DETAIL_*, "status": code}` - which is
        what stops the classic SSE failure mode of a bare close the client cannot interpret.

    `produce`는 `(EVENT_PHASE|EVENT_DELTA, payload)`를 yield하는 async 제너레이터 팩토리이며, 라우트별
    차이(기사 본문 조회, 종목 입력 수집)는 전부 그 안에 있다. `build_data`는 누적된 델타 텍스트로 캐시에
    담길 데이터 dict를 만든다.
    `produce` is an async-generator factory yielding `(EVENT_PHASE|EVENT_DELTA, payload)` pairs and holds
    every route-specific step (the article fetch, the stock input gathering); `build_data` turns the
    accumulated delta text into the dict that gets cached.
    """
    data: Optional[dict] = None
    as_of: Optional[str] = None
    try:
        yield _sse(EVENT_PHASE, {"phase": first_phase})

        cached = await state.cache.peek(key, config.AI_TTL)
        if cached is not None:
            data, as_of = cached
        else:
            # 아래 세 줄 사이에 await가 없어야 원자적이다 (단일 이벤트 루프): `peek`의 await에서 깨어난
            # 직후 레지스트리를 읽고, 등록까지 양보 없이 끝낸다 - 두 코루틴이 같은 키의 선점자가 될 수 없다.
            # These lines must contain no await to be atomic on the single event loop: the registry is read
            # right after `peek` resumes and the registration completes without yielding, so two coroutines
            # can never both become the leader for one key.
            leader_future = inflight.get(key)
            if leader_future is None:
                own_future = asyncio.get_running_loop().create_future()
                inflight[key] = own_future
                try:
                    parts: list[str] = []
                    # aclosing: 소비자가 사라지면(`GeneratorExit`) `produce()`를 GC 시점이 아니라
                    # 지금 닫는다 - Bedrock permit 반납과 fetch permit 반납이 그 안의 `finally`에
                    # 있으므로, 닫히는 시점이 정산되는 시점이다.
                    # aclosing: when the consumer leaves (`GeneratorExit`) `produce()` is closed here, not
                    # at some GC tick - the Bedrock and fetch permit returns live in its `finally`s, so
                    # when it closes is when they settle.
                    async with contextlib.aclosing(produce()) as events:
                        async for event, payload in events:
                            if event == EVENT_DELTA:
                                parts.append(payload["text"])
                            yield _sse(event, payload)

                    data = build_data("".join(parts))
                    await state.cache.put(key, data, config.AI_TTL)
                    # put이 찍은 asOf를 그대로 쓴다 - 스트림 응답과 이후 캐시 응답의 asOf가 어긋나면 안 된다
                    # Reuse the asOf `put` stamped: the streamed response and later cache hits must agree
                    peeked = await state.cache.peek(key, config.AI_TTL)
                    as_of = peeked[1] if peeked is not None else None
                    own_future.set_result((OUTCOME_OK, data, as_of))
                except HTTPException as exc:
                    # `produce`가 정한 상태 코드를 다시 매핑하지 않는다 (502가 500으로 뒤바뀌면 안 된다)
                    # Never remap a status code `produce` already chose (a 502 must not turn into a 500)
                    own_future.set_result((OUTCOME_ERROR, exc.detail, exc.status_code))
                    raise
                except bedrock_ai.BedrockUnavailableError as exc:
                    _warn("ai_unavailable", key=key, error=str(exc))
                    own_future.set_result((OUTCOME_ERROR, DETAIL_AI_UNAVAILABLE, 503))
                    yield _sse(EVENT_FINAL, {"error": DETAIL_AI_UNAVAILABLE, "status": 503})
                    return
                except Exception as exc:
                    # BedrockCallError(잘못된 입력·스트림 실패)와 예기치 못한 오류를 함께 500으로 매핑한다
                    # BedrockCallError (bad input, stream failure) and unexpected errors both map to 500
                    # 스택 트레이스는 운영 원인 추적용 - 단일 라인 JSON 규칙의 의도적 예외
                    # The stack trace is for operational root-causing: a deliberate exception to the
                    # one-line-JSON rule (the JSON line below stays machine-readable).
                    logger.exception("ai stream failed key=%s", key)
                    _warn("ai_failed", key=key, error=str(exc), error_type=type(exc).__name__)
                    own_future.set_result((OUTCOME_ERROR, DETAIL_AI_FAILED, 500))
                    yield _sse(EVENT_FINAL, {"error": DETAIL_AI_FAILED, "status": 500})
                    return
                finally:
                    if not own_future.done():
                        # 소비자 이탈(GeneratorExit) 등으로 결과가 없으면 팔로워가 영원히 기다린다
                        # Without a result (e.g. the consumer left, raising GeneratorExit) a follower
                        # would wait forever, so the abandoned attempt is reported as a failure.
                        _warn("ai_stream_leader_gone", key=key)
                        own_future.set_result((OUTCOME_ERROR, DETAIL_AI_FAILED, 500))
                    inflight.pop(key, None)
            else:
                # 팔로워: 선점자를 기다리며 하트비트 / Follower: heartbeat while the leader works.
                # Future에는 예외를 넣지 않는다 (튜플 결과만) - 회수되지 않은 예외 경고를 만들지 않기 위해서다.
                # The future never carries an exception, only tuples, so no "never retrieved" warning fires.
                async with contextlib.aclosing(_waiting_heartbeats(leader_future)) as beats:
                    async for event, payload in beats:
                        yield _sse(event, payload)
                outcome = leader_future.result()
                if outcome[0] == OUTCOME_ERROR:
                    _tag, detail, status = outcome
                    yield _sse(EVENT_FINAL, {"error": detail, "status": status})
                    return
                _tag, data, as_of = outcome

        yield _sse(EVENT_FINAL, envelope(data, deps.market_open_now(), as_of))
    except HTTPException as exc:
        # 선점자 경로에서 올라온 오류(예: 기사 502) + 그 외 HTTP 오류를 final로 내보낸다
        # Errors raised on the leader path (e.g. the article 502) leave as a final, not as a bare close
        yield _sse(EVENT_FINAL, {"error": exc.detail, "status": exc.status_code})


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
    종목 AI 분석 SSE 스트림 (한국어 마크다운) / AI stock analysis as an SSE stream of Korean markdown.

    본문은 없다. 프롬프트 입력(가격/PER/52주/섹터/뉴스 제목)은 이미 캐시된 상세·종목뉴스에서 가져오므로
    AI 요청이 yfinance/RSS를 새로 때리는 일은 보통 없다. 그 수집은 첫 `phase` 이벤트 **뒤**에 수행한다
    (TTFB를 캐시·업스트림에 묶지 않는다).
    There is no request body. The prompt inputs (price, P/E, 52-week range, sector, news titles) come from
    the already-cached detail and per-symbol news, so an AI request rarely hits yfinance or RSS; that
    gathering happens *after* the first `phase` event so TTFB never waits on the cache or upstream.

    Returns:
        `text/event-stream`: `phase: analyzing` -> `delta`* -> `final`(envelope 또는 오류) -
        한도 초과 시에는 스트림 전에 429 JSONResponse.
        A `text/event-stream` (`phase: analyzing`, then deltas, then a `final` carrying the envelope or an
        error), or a 429 JSONResponse decided before the stream starts.
    """
    limited = rate_limited(request)
    if limited is not None:
        return limited
    semaphore = get_semaphore(request)
    inflight = get_inflight(request)

    async def produce() -> AsyncIterator[Tuple[str, dict]]:
        # 가격 오버레이가 적용된 상세를 그대로 쓴다 (테이블·헤더·호가와 같은 가격으로 분석한다)
        # The price-overlaid detail is reused, so the analysis sees the same price as the table and header
        detail, _as_of = await stocks.detail_view(state, symbol)
        titles = await recent_news_titles(state, symbol)
        deltas = _bedrock_deltas(
            state,
            semaphore,
            lambda: bedrock_ai.analyze_stock_stream(
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
            # 첫 이벤트가 이미 analyzing이었다 - permit을 기다렸을 때만 다시 알린다
            # The first event was already `analyzing`; it is re-announced only after a permit wait
            analyzing_announced=True,
        )
        # aclosing: 이탈 시 permit 반납(`_bedrock_deltas`의 finally)을 GC가 아니라 여기서 확정한다
        # aclosing: on departure the permit return (`_bedrock_deltas`'s finally) is settled here, not by GC
        async with contextlib.aclosing(deltas) as events:
            async for event in events:
                yield event

    # 주식은 조회할 본문이 없으므로 `fetching` 없이 `analyzing`부터 시작한다 (fetch 세마포어도 기사 전용)
    # A stock has no body to fetch, so it starts at `analyzing` (the fetch semaphore is article-only)
    return StreamingResponse(
        _analysis_stream(
            state,
            inflight,
            key_stock_ai(symbol),
            PHASE_ANALYZING,
            produce,
            lambda analysis: {"symbol": symbol, "analysis": analysis},
        ),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


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
        `text/event-stream`: `phase: fetching` -> `phase: analyzing` -> `delta`* -> `final`(envelope 또는
        오류) - 한도 초과 시에는 스트림 전에 429 JSONResponse.
        A `text/event-stream` (`phase: fetching`, `phase: analyzing`, deltas, then a `final` carrying the
        envelope or an error), or a 429 JSONResponse decided before the stream starts.
    """
    limited = rate_limited(request)
    if limited is not None:
        return limited
    semaphore = get_semaphore(request)
    fetch_semaphore = get_fetch_semaphore(request)
    inflight = get_inflight(request)

    async def produce() -> AsyncIterator[Tuple[str, dict]]:
        # fetch는 **전용** 세마포어 안에서 돈다 (2026-08-03 보안 리뷰 F2 + 재검증 breakage 1):
        # 캡 상향(2MB) 후 fetch 한 건이 수 MB 버퍼를 잡으므로 동시 fetch 버퍼 누적을
        # AI_FETCH_CONCURRENCY개로 묶는다. Bedrock 세마포어와 분리한 이유: 하나를 같이 쓰면 느린
        # fetch(최대 20s 점유)가 Bedrock 예산을 잠식해 IP 2개로 AI 기능 전체가 대기열에 갇힌다.
        # 이 세마포어는 동시 fetch 버퍼만 묶는다 — Bedrock 호출량은 `_bedrock_deltas`의 세마포어가 묶는다.
        # The fetch runs inside its **own** semaphore (security review F2 + re-review breakage 1,
        # 2026-08-03): after the 2MB cap raise one fetch holds multi-MB buffers, so concurrent fetch
        # buffers are capped at AI_FETCH_CONCURRENCY. It is separate from the Bedrock semaphore because
        # sharing one lets slow fetches (holding up to 20s) starve the Bedrock budget — two IPs could
        # queue-lock every AI feature. This semaphore bounds concurrent fetch buffers only; Bedrock
        # volume is bounded by `_bedrock_deltas`'s semaphore.
        #
        # 획득 대기도 Bedrock permit과 **같은** 하트비트 패턴을 쓴다 (최종 리뷰 fast-follow #1):
        # `async with fetch_semaphore`는 침묵 구간이었다 - 느린 fetch `AI_FETCH_CONCURRENCY`(2)건 뒤에
        # 줄 선 요청은 첫 `fetching` 이벤트 뒤로 한 바이트도 못 내보내고, 자기 fetch가 시작된 뒤에도
        # `FETCH_TOTAL_DEADLINE`(20s)까지 더 조용할 수 있다. permit은 본문 조회까지만 들고
        # (Bedrock 스트림은 자기 세마포어를 따로 기다린다) `finally`에서 반드시 반납한다.
        # The acquisition wait uses the **same** heartbeat pattern as the Bedrock permit (final-review
        # fast-follow #1): `async with fetch_semaphore` was a silent window - a request queued behind
        # `AI_FETCH_CONCURRENCY` (2) slow fetches emitted nothing after its first `fetching` event, and its
        # own fetch can stay quiet for up to `FETCH_TOTAL_DEADLINE` (20s) more. The permit is held only
        # until the body is in (the Bedrock stream waits on its own semaphore) and always handed back in
        # the `finally`.
        fetch_acquire: "asyncio.Future[bool]" = asyncio.ensure_future(fetch_semaphore.acquire())
        try:
            # 첫 이벤트가 이미 `fetching`이었다 - permit을 기다렸을 때만 다시 알린다
            # The first event was already `fetching`; it is re-announced only after a permit wait
            async with contextlib.aclosing(
                _permit_wait(fetch_acquire, PHASE_FETCHING, announced=True)
            ) as permit_events:
                async for event in permit_events:
                    yield event
            content = await news.fetch_article_content(payload.url)
        finally:
            _return_permit(fetch_semaphore, fetch_acquire)

        if not content:
            # 본문이 없으면 분석은 무의미하다: Bedrock을 부르지도, 실패를 캐시하지도 않는다
            # Without a body there is nothing to analyze: no Bedrock call, and no cached failure
            _warn("ai_article_content_empty", url=payload.url)
            raise HTTPException(status_code=502, detail=DETAIL_ARTICLE_UNAVAILABLE)

        # 본문을 확보하고 permit까지 든 뒤에 분석 단계를 알린다 (`_bedrock_deltas`가 emit한다) -
        # 사용자는 fetching -> (대기 시 waiting) -> analyzing을 사실 그대로 본다.
        # The analysis phase is announced once the body *and* the permit are in hand (`_bedrock_deltas`
        # emits it), so the user truthfully sees fetching -> (waiting, if queued) -> analyzing.
        deltas = _bedrock_deltas(
            state,
            semaphore,
            lambda: bedrock_ai.analyze_article_stream(payload.title, content, payload.language == "ko"),
            analyzing_announced=False,
        )
        # aclosing: 이탈 시 permit 반납(`_bedrock_deltas`의 finally)을 GC가 아니라 여기서 확정한다
        # aclosing: on departure the permit return (`_bedrock_deltas`'s finally) is settled here, not by GC
        async with contextlib.aclosing(deltas) as events:
            async for event in events:
                yield event

    return StreamingResponse(
        _analysis_stream(
            state,
            inflight,
            key_article_ai(payload.url),
            PHASE_FETCHING,
            produce,
            lambda analysis: {
                "url": payload.url,
                "title": payload.title,
                "language": payload.language,
                "analysis": analysis,
            },
        ),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
