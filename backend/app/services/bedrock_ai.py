"""
Bedrock AI 서비스 - Claude 모델로 뉴스 기사 분석과 종목 분석을 수행
Bedrock AI service - news article analysis and stock analysis via a Claude model.

TUI(`$TUI/services/bedrock.py`) 포팅. 프롬프트는 그대로 유지하고, 서버 환경에 맞춰 세 가지만 바꿨다.
Ported from the TUI module: the prompts are kept as they were, with exactly three server-side changes.

1. 리전은 `config.BEDROCK_REGION`(기본 `ap-northeast-2`) / The region comes from config (default ap-northeast-2).
2. BEDROCK_API_KEY 분기 제거 — 자격 증명은 ECS Task Role이 제공한다 / No API-key branch: the ECS Task Role supplies credentials.
3. 실패 시 안내 문자열을 반환하지 않고 `BedrockUnavailableError`/`BedrockCallError`를 raise한다
   (API 계층이 각각 503/500으로 매핑) / Failures raise typed errors instead of returning a message
   (the API layer maps them to 503/500).

호출 프리미티브는 **`converse_stream`** 하나뿐이다(`stream_invoke`): 라우트가 SSE로 전환되면서
블로킹 `invoke_model` 경로는 참조가 사라져 삭제했다. 프롬프트 조립은 `_stock_prompt`/`_article_prompt`에
있고 두 스트리밍 variant(`analyze_stock_stream`/`analyze_article_stream`)가 그 문자열을 쓴다.
There is exactly one call primitive, `stream_invoke` over **`converse_stream`**: once the routes moved to
SSE the blocking `invoke_model` path had no callers left and was removed. Prompt assembly lives in
`_stock_prompt`/`_article_prompt`, which the two streaming variants use.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Any, AsyncIterator, NoReturn, Optional

import boto3
from botocore.exceptions import ClientError, NoCredentialsError

from app.core import config

logger = logging.getLogger(__name__)

# 기사 분석 / 종목 분석 응답 토큰 상한 / Response token caps for the article and stock analyses.
#
# 기사 상한은 2026-08-04 사용자 승인으로 2048 -> 4096으로 올렸다. 라이브 E2E에서 실제 기사 분석 2건이
# `ai_stream_truncated`(stop_reason=max_tokens)로 잘렸다 - 긴 영문 기사의 번역+요약 전문은 2048에
# 들어가지 않으며, 잘린 결과가 그대로 AI_TTL(6h) 동안 캐시된다(사용자는 재시도로도 복구할 수 없다).
# 4096은 여유를 두 배로 벌어 준다. SSE 전환으로 wall-clock 우려는 사라졌고(델타가 연결을 살려 둔다),
# 비용은 실제로 더 필요한 기사에서만 늘어난다. 종목 상한은 1024 그대로다 - 짧은 한국어 코멘트라
# 절단이 관측되지 않았고, 시나리오별 상한 분리가 `ai_stream_truncated` 신호의 의미를 지켜 준다.
# The article cap was raised 2048 -> 4096 with user approval on 2026-08-04: a live end-to-end run had two
# real article analyses cut short by `ai_stream_truncated` (stop_reason=max_tokens). A full
# translation+summary of a longer English article does not fit in 2048, and the truncated output is then
# cached for AI_TTL (6h), so a retry cannot repair it. 4096 doubles the headroom. SSE removed the
# wall-clock concern (the deltas keep the connection alive), and cost only grows for the articles that
# genuinely need the room. The stock cap stays 1024: no truncation was ever observed for its short Korean
# commentary, and keeping the two caps separate is what gives `ai_stream_truncated` its meaning.
ARTICLE_MAX_TOKENS = 4096
STOCK_MAX_TOKENS = 1024
# 프롬프트에 담는 기사 본문 최대 길이 / Maximum article body length carried in the prompt
ARTICLE_CONTENT_LIMIT = 6000
# 프롬프트에 담는 최근 뉴스 제목 개수 / Number of recent news titles carried in the prompt
NEWS_TITLE_LIMIT = 5

# 자격 증명·권한 문제로 보는 Bedrock 에러 코드 (503 대상) / Bedrock error codes treated as "unavailable" (503)
_UNAVAILABLE_ERROR_CODES = frozenset({
    "AccessDeniedException",
    "UnrecognizedClientException",
    "ExpiredTokenException",
    "InvalidSignatureException",
})

# 가용성 캐시: 성공만 기억한다 (일시적 실패 후 복구 가능해야 하므로)
# Availability cache: only successes are remembered, so a transient failure can still recover.
_bedrock_available: Optional[bool] = None


class BedrockUnavailableError(Exception):
    """자격 증명 없음 또는 모델 접근 거부 / No credentials, or model access denied (API layer: 503)."""


class BedrockCallError(Exception):
    """invoke 실패 또는 응답 해석 실패 / The invoke failed, or the response could not be read (API layer: 500)."""


def _log_failure(event: str, error: Exception, **fields: Any) -> None:
    """실패를 단일 라인 JSON으로 기록 (조용한 실패 금지) / Log a failure as single-line JSON (no silent failures)."""
    payload = {"event": event, "error": str(error), "error_type": type(error).__name__}
    payload.update(fields)
    logger.error(json.dumps(payload, default=str, ensure_ascii=False))


def _warn(event: str, **fields: Any) -> None:
    """예외 없는 이상 신호를 단일 라인 JSON 경고로 기록 / Log a non-exception anomaly as single-line JSON."""
    payload = {"event": event}
    payload.update(fields)
    logger.warning(json.dumps(payload, default=str, ensure_ascii=False))


def is_bedrock_available() -> bool:
    """
    boto3 기본 자격 증명이 해석되는지 확인 / Check whether boto3 default credentials resolve.

    ECS Task Role·환경변수·`aws configure` 등 기본 체인을 그대로 사용한다. 성공 결과만 캐시하므로
    (컨테이너 크레덴셜 엔드포인트의 일시적 실패로) 한 번 실패해도 다음 호출에서 다시 시도한다.
    Uses the default provider chain (ECS Task Role, env vars, `aws configure`). Only a positive
    result is cached, so a transient resolution failure is retried on the next call.
    """
    global _bedrock_available
    if _bedrock_available:
        return True
    try:
        creds = boto3.Session().get_credentials()
        if creds is None:
            return False
        frozen = creds.get_frozen_credentials()
        available = bool(frozen.access_key and frozen.secret_key)
    except Exception as exc:
        _log_failure("bedrock_credentials_error", exc)
        return False
    if available:
        _bedrock_available = True
    return available


def _get_client():
    """
    bedrock-runtime 클라이언트 생성 / Create the bedrock-runtime client.

    Raises:
        BedrockUnavailableError: 기본 자격 증명이 없을 때 / when no default credentials resolve.
    """
    if not is_bedrock_available():
        raise BedrockUnavailableError(
            "AWS 자격 증명이 없어 Bedrock을 사용할 수 없습니다 / No AWS credentials available for Bedrock"
        )
    return boto3.client("bedrock-runtime", region_name=config.BEDROCK_REGION)


def _is_unavailable(exc: Exception) -> bool:
    """자격 증명·권한 계열 오류인지 판별 / Tell credential/authorization failures from other errors."""
    if isinstance(exc, NoCredentialsError):
        return True
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code")
        return code in _UNAVAILABLE_ERROR_CODES
    return False


def _raise_mapped(exc: Exception, event: str) -> NoReturn:
    """
    실패를 로그로 남기고 타입 있는 예외로 다시 던진다 / Log the failure, then re-raise it as a typed error.

    호출부는 프롬프트 조립과 모델 호출을 하나의 try로 감싼다(TUI와 동일). 잘못된 입력(예: `price=None`)이
    포맷 단계에서 터지는 것도 여기서 `BedrockCallError`로 매핑되므로, 이 모듈을 벗어나는 예외는 항상
    `BedrockUnavailableError` 아니면 `BedrockCallError`다.
    Callers wrap prompt assembly *and* the invoke in one try (as the TUI did), so a bad input blowing up in
    a formatter (e.g. `price=None`) is mapped here too: only the two typed errors ever leave this module.

    Raises:
        BedrockUnavailableError: 자격 증명 없음 / 모델 접근 거부 / no credentials or access denied.
        BedrockCallError: 그 외 조립·호출·응답 실패 / any other assembly, invoke or response failure.
    """
    _log_failure(event, exc, model_id=config.BEDROCK_MODEL_ID, region=config.BEDROCK_REGION)
    # 가용성 실패는 재분류하지 않는다 (503이 500으로 뒤바뀌면 안 된다)
    # Availability failures are never reclassified (a 503 must not turn into a 500).
    if isinstance(exc, BedrockUnavailableError):
        raise exc
    if _is_unavailable(exc):
        raise BedrockUnavailableError(str(exc)) from exc
    raise BedrockCallError(str(exc)) from exc


# 스트림 브리지 큐 항목 종류 / Item kinds on the bridge queue
_QUEUE_DELTA = "delta"
_QUEUE_STOP = "stop"
_QUEUE_ERROR = "error"
_QUEUE_END = "end"


def _abort_stream(stream: Any) -> None:
    """
    버려진 이벤트 스트림을 닫아 소켓을 돌려준다 / Close an abandoned event stream to release its socket.

    조기 종료(소비자 이탈) 전용 — botocore `EventStream.close()`가 원본 HTTP 응답을 닫는다. 닫기 실패는
    이미 버린 스트림이라 치명적이지 않지만 조용히 넘기지 않는다.
    Cancellation path only: botocore's `EventStream.close()` closes the raw HTTP response. A close
    failure is not fatal (the stream is being abandoned anyway) but is never silent.
    """
    close = getattr(stream, "close", None)
    if close is None:
        return
    try:
        close()
    except Exception as exc:
        _warn("ai_stream_close_failed", error=str(exc), error_type=type(exc).__name__)


async def stream_invoke(prompt: str, max_tokens: int) -> AsyncIterator[str]:
    """
    converse_stream으로 모델을 호출해 텍스트 델타를 즉시 yield / Invoke via converse_stream, yielding text deltas as they arrive.

    boto3 이벤트 스트림은 동기이므로 **전용 스레드**가 이벤트를 읽어 `call_soon_threadsafe`로
    asyncio.Queue에 밀어 넣는다. 공용 default executor를 쓰지 않는 이유: 스트림 하나가 최대 수십 초를
    점유하는데 그 풀은 yfinance·본문 추출과 공유된다 (2026-08-03 보안 리뷰). 동시 스레드 수는
    호출부의 Bedrock 세마포어(AI_GLOBAL_CONCURRENCY)가 묶는다.
    The boto3 event stream is synchronous, so a dedicated thread reads it and pushes into an
    asyncio.Queue via call_soon_threadsafe. The shared default executor is deliberately avoided: one
    stream holds a slot for tens of seconds and that pool is shared with yfinance and extraction
    (security review 2026-08-03). Thread count is bounded by the caller's Bedrock semaphore.

    그 상한이 성립하려면 소비자가 사라질 때 펌프도 멈춰야 한다: 제너레이터가 닫히면(SSE 클라이언트
    disconnect → `GeneratorExit`) `finally`가 취소 플래그를 세우고, 펌프는 **다음 이벤트 경계에서**
    읽기를 중단한다. 즉 고아 스레드는 이벤트 하나(네트워크가 조용하면 botocore read 타임아웃)만큼만
    살아남고, 세마포어가 풀린 뒤까지 스트림을 끝까지 읽는 일은 없다.
    That bound only holds if the pump stops when the consumer does: closing the generator (an SSE
    client disconnect raising `GeneratorExit`) sets a cancel flag in `finally`, and the pump stops
    reading **at the next event boundary**. An orphaned pump therefore outlives its consumer by one
    event (or a botocore read timeout when the wire is quiet), never by a whole drained stream.

    `stopReason == "max_tokens"`는 진짜 절단 시그널이라 경고로 남긴다 (시나리오별 max_tokens 분리 덕에
    이 로그가 의미를 갖는다). / A max_tokens stop is logged as the truncation signal it is.

    Raises:
        BedrockUnavailableError: 자격 증명 없음 / 모델 접근 거부 / no credentials or access denied.
        BedrockCallError: 그 외 호출·스트림 실패 / any other invoke or stream failure.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    # 소비자가 떠났음을 펌프에 알리는 플래그 / Tells the pump its consumer is gone
    cancelled = threading.Event()

    def dropped(kind: str, value: Any, reason: str, detail: str = "") -> None:
        """
        전달하지 못한 항목을 단일 라인 JSON으로 남긴다 (조용한 실패 금지) / Log an undeliverable item.

        소비자가 사라진 뒤의 실패는 raise할 곳이 없다 — 그래도 보이지 않게 사라지면 안 된다.
        델타 본문은 남기지 않는다(모델 출력이므로 종류만 기록) / delta text is never logged.
        A failure arriving after the consumer left has nowhere to be raised, but must stay visible.
        """
        fields: dict[str, Any] = {"reason": reason, "kind": kind}
        if isinstance(value, BaseException):
            fields["error"] = str(value)
            fields["error_type"] = type(value).__name__
        if detail:
            fields["detail"] = detail
        _warn("ai_stream_dropped", **fields)

    def put(kind: str, value: Any) -> None:
        # 루프가 닫힌 뒤(앱 종료 중)에는 소비자가 없다 — 여기서 RuntimeError를 흘리면 스레드 예외
        # 트레이스백만 남으므로 삼키되, 무엇이 사라졌는지는 로그로 남긴다.
        # After the loop is closed (shutdown) there is no consumer left; letting the RuntimeError
        # escape would only print a thread traceback, so it is swallowed — but never unlogged.
        try:
            loop.call_soon_threadsafe(queue.put_nowait, (kind, value))
        except RuntimeError as exc:
            dropped(kind, value, reason="loop_closed", detail=str(exc))

    def pump() -> None:
        try:
            client = _get_client()
            response = client.converse_stream(
                modelId=config.BEDROCK_MODEL_ID,
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig={"maxTokens": max_tokens},
            )
            stream = response["stream"]
            for event in stream:
                if cancelled.is_set():
                    # 소비자가 끊겼다: 남은 이벤트를 읽지 않고 스트림을 닫고 스레드를 끝낸다 (세마포어 상한 유지)
                    # The consumer is gone: close the stream and stop reading instead of draining.
                    _abort_stream(stream)
                    return
                text = event.get("contentBlockDelta", {}).get("delta", {}).get("text")
                if text:
                    put(_QUEUE_DELTA, text)
                stop = event.get("messageStop", {}).get("stopReason")
                if stop is not None:
                    put(_QUEUE_STOP, stop)
        except Exception as exc:  # noqa: BLE001 - 스레드 경계, 큐로 전달 / thread boundary: forwarded via the queue
            if cancelled.is_set():
                # 큐를 읽을 소비자가 없으므로 넣어도 사라진다 — 로그로만 남긴다
                # No consumer is left to read the queue, so this is logged instead of enqueued.
                dropped(_QUEUE_ERROR, exc, reason="consumer_gone")
            else:
                put(_QUEUE_ERROR, exc)
        else:
            if not cancelled.is_set():
                put(_QUEUE_END, None)

    threading.Thread(target=pump, name="bedrock-stream", daemon=True).start()

    try:
        while True:
            kind, value = await queue.get()
            if kind == _QUEUE_DELTA:
                yield value
            elif kind == _QUEUE_STOP:
                if value == "max_tokens":
                    _warn("ai_stream_truncated", stop_reason=value, max_tokens=max_tokens)
            elif kind == _QUEUE_ERROR:
                _raise_mapped(value, "ai_stream_failed")
            else:
                return
    finally:
        # 정상 종료·GeneratorExit(조기 close)·예외 모두 여기를 지난다 → 펌프에 즉시 알린다
        # Normal exit, GeneratorExit (early close) and errors all pass here: tell the pump at once.
        cancelled.set()


def _article_prompt(title: str, content: str, is_korean: bool) -> str:
    """
    기사 분석 프롬프트 조립 / Assemble the article-analysis prompt.

    조립을 호출 프리미티브와 분리해 둔다 — 프롬프트는 이 함수 하나에만 있으므로 문구 변경이
    스트리밍 경로 전체에 그대로 반영된다.
    Assembly is kept apart from the call primitive: the prompt lives here alone, so a wording change
    reaches the whole streaming path at once.
    """
    if is_korean:
        # 한국어 기사용 프롬프트: 요약, 분석, 투자 인사이트, 관련 종목 / Korean article prompt: summary, analysis, investment insights, related stocks
        return f"""다음 경제/금융 뉴스 기사를 분석해 주세요.

제목: {title}

본문:
{content[:ARTICLE_CONTENT_LIMIT]}

다음 형식으로 한국어로 작성해 주세요:

## 요약
(기사의 핵심 내용을 3-5문장으로 요약)

## 분석
(이 뉴스가 시장에 미치는 영향, 관련 산업/기업에 대한 분석)

## 투자 인사이트
(투자자 관점에서의 시사점, 주목할 포인트)

## 관련 종목
(이 뉴스와 관련된 주요 종목들)"""

    # 영어 기사용 프롬프트: 번역 + 요약 + 분석 + 투자 인사이트 + 관련 종목 / English article prompt: translation + summary + analysis + investment insights + related stocks
    return f"""다음 영문 경제/금융 뉴스 기사를 한국어로 번역하고 분석해 주세요.

Title: {title}

Content:
{content[:ARTICLE_CONTENT_LIMIT]}

다음 형식으로 한국어로 작성해 주세요:

## 한국어 번역
(기사 핵심 내용의 한국어 번역, 3-5문장)

## 요약
(기사의 핵심 내용을 3-5문장으로 요약)

## 분석
(이 뉴스가 글로벌 시장 및 한국 시장에 미치는 영향 분석)

## 투자 인사이트
(투자자 관점에서의 시사점, 주목할 포인트)

## 관련 종목
(이 뉴스와 관련된 주요 종목들 - 미국/한국)"""


def _stock_prompt(
    symbol: str,
    name: str,
    price: float,
    change_pct: float,
    pe_ratio: Optional[float] = None,
    week52_high: float = 0,
    week52_low: float = 0,
    sector: str = "",
    market: str = "US",
    news_titles: Optional[list] = None,
) -> str:
    """
    종목 분석 프롬프트 조립 / Assemble the stock-analysis prompt.

    `analyze_stock_stream`이 쓴다 / Used by `analyze_stock_stream`.
    잘못된 입력(예: `price=None`)은 여기서 TypeError로 터지고, 호출부가 `_raise_mapped`로 매핑한다.
    Bad input (e.g. `price=None`) raises TypeError here; callers map it via `_raise_mapped`.
    """
    # 최근 뉴스 제목을 문자열로 변환 (최대 5개) / Convert recent news titles to string (max 5)
    news_str = ""
    if news_titles:
        news_str = "\n".join(f"- {t}" for t in news_titles[:NEWS_TITLE_LIMIT])

    # PER 값을 문자열로 변환 (없으면 N/A) / Convert PE ratio to string (N/A if not available)
    per_str = f"{pe_ratio:.2f}" if pe_ratio else "N/A"
    # 현재 가격의 52주 범위 내 위치를 백분율로 계산 / Calculate current price position within 52-week range as percentage
    w52_pct = ((price - week52_low) / (week52_high - week52_low) * 100) if week52_high > week52_low else 0

    # 종목 분석 프롬프트: 기술적 분석, 투자 포인트, 리스크 요인 / Stock analysis prompt: technical analysis, investment points, risk factors
    return f"""다음 종목을 간결하게 분석해 주세요. 각 항목을 2-3문장으로 작성하세요.

종목: {symbol} ({name})
시장: {"미국" if market == "US" else "한국"}
섹터: {sector or "N/A"}
현재가: {price:,.2f} ({change_pct:+.2f}%)
PER: {per_str}
52주 범위: {week52_low:,.2f} ~ {week52_high:,.2f} (현재 위치: {w52_pct:.0f}%)

최근 뉴스:
{news_str if news_str else "(없음)"}

다음 형식으로 한국어로 간결하게 작성해 주세요:

## 기술적 분석
(가격 위치, 추세, 모멘텀에 대한 간단 분석)

## 투자 포인트
(이 종목의 매력 포인트 2-3개)

## 리스크 요인
(주의할 리스크 2-3개)"""


def analyze_stock_stream(**kwargs: Any) -> AsyncIterator[str]:
    """
    종목 분석 스트림 / Stream a stock analysis.

    인자는 `_stock_prompt`와 동일(키워드 전용) / Same arguments as `_stock_prompt` (keyword-only).

    Raises:
        BedrockUnavailableError: 자격 증명 없음 / 모델 접근 거부 / no credentials or access denied.
        BedrockCallError: 그 외 호출 실패, 그리고 잘못된 입력으로 인한 조립 실패
            / any other failure, plus assembly failures from bad input.
    """
    # 조립은 즉시(반복 시작 전에) 수행한다 — 잘못된 입력이 첫 델타를 기다리지 않고 곧바로 타입 예외로 나간다
    # Assembly runs eagerly (before iteration) so bad input leaves as a typed error at once.
    try:
        prompt = _stock_prompt(**kwargs)
    except Exception as exc:
        _raise_mapped(exc, "bedrock_stock_analysis_error")
    return stream_invoke(prompt, STOCK_MAX_TOKENS)


def analyze_article_stream(title: str, content: str, is_korean: bool) -> AsyncIterator[str]:
    """
    기사 분석 스트림 / Stream an article analysis.

    Raises:
        BedrockUnavailableError: 자격 증명 없음 / 모델 접근 거부 / no credentials or access denied.
        BedrockCallError: 그 외 호출 실패, 그리고 잘못된 입력으로 인한 조립 실패
            / any other failure, plus assembly failures from bad input.
    """
    try:
        prompt = _article_prompt(title, content, is_korean)
    except Exception as exc:
        _raise_mapped(exc, "bedrock_article_analysis_error")
    return stream_invoke(prompt, ARTICLE_MAX_TOKENS)
