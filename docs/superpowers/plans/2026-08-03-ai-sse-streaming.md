# AI 분석 SSE 스트리밍 + 마크다운 렌더링 개선 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 두 AI 엔드포인트를 Bedrock `converse_stream` 기반 SSE(phase→delta→final)로 전면 전환해 CloudFront wall-clock 제약을 없애고 토큰을 실시간 표시하며, 프론트 마크다운 렌더링에 remark-gfm을 더한다.

**Architecture:** 5태스크 — ① `bedrock_ai`에 스레드→asyncio.Queue 브리지 스트리밍 프리미티브, ② `TieredCache.peek` + 두 라우트 SSE 전환(선점자/팔로워 inflight 레지스트리, final 항상 emit) + 백엔드 테스트 개편, ③ 프론트 SSE 파서(순수 함수)+스트리밍 훅, ④ UI 실시간 렌더 + remark-gfm + CSS, ⑤ 로컬 E2E 검증. 인프라 변경 0.

**Tech Stack:** boto3 bedrock-runtime `converse_stream`, FastAPI `StreamingResponse`, fetch `ReadableStream` + TextDecoder, react-markdown v10 + remark-gfm v4, pytest/vitest.

**스펙:** `docs/superpowers/specs/2026-08-03-ai-sse-streaming-design.md` (사용자 승인 2026-08-03)

## Global Constraints

- **SSE 프로토콜은 스펙 §2 그대로**: 이벤트명 `phase`/`delta`/`final`, data는 JSON. `phase`는 `{"phase": "fetching"|"analyzing"|"waiting"}`, `delta`는 `{"text": "..."}`, `final`은 성공 시 기존 envelope(`{"asOf","marketOpen","data":{...}}`) / 실패 시 `{"error": "<기존 DETAIL_* 문구>", "status": <기존 코드>}`. **final은 어떤 경로에서도 반드시 emit.**
- 레이트리밋 429는 스트림 시작 전 — 기존 JSON 응답 그대로 유지.
- 캐시 키(`key_stock_ai`/`key_article_ai`)·`AI_TTL`·세마포어 의미(`AI_GLOBAL_CONCURRENCY`는 Bedrock 스트림 완료까지, `AI_FETCH_CONCURRENCY`는 기사 fetch) 불변.
- `ARTICLE_MAX_TOKENS = 2048` / `STOCK_MAX_TOKENS = 1024` 불변. `stopReason == "max_tokens"`는 `_warn`으로 기록.
- boto3 스트림 읽기는 **전용 스레드** (`threading.Thread(daemon=True)`) — 공용 default executor를 45초씩 점유하지 않는다 (2026-08-03 보안 리뷰 F2/F3의 executor 공유 경고).
- 예외 시 서버 로그에 **스택 트레이스** (`logger.exception`) — 단일 라인 JSON `_warn` 규칙의 예외이며 그 이유(운영 원인 추적)를 주석으로 남긴다.
- 주석·테스트 설명 한국어+영어 병기. 색상은 `tokens.css` 변수만. TypeScript strict.
- 프론트 "서버 상태는 react-query" 규칙의 **명시적 예외**: SSE 스트리밍은 react-query가 지원하지 않는 형태이므로 스트리밍 훅만 fetch 직접 사용 — 훅 주석에 이 사유를 남기고, 나머지 데이터는 계속 react-query.
- 각 태스크 끝: 백엔드는 `cd backend && .venv/bin/pytest -q`(현재 302), 프론트는 `cd frontend && npx vitest run`(현재 116) 그린. 커밋 제목 Conventional Commits(영어), **Co-Authored-By 금지**.

---

### Task 1: bedrock_ai 스트리밍 프리미티브 (`converse_stream` + 스레드 브리지)

**Files:**
- Modify: `backend/app/services/bedrock_ai.py`
- Test: `backend/tests/test_bedrock_ai.py`

**Interfaces:**
- Consumes: 기존 `_get_client()`, `config.BEDROCK_MODEL_ID`, 기존 프롬프트 조립 로직(`analyze_stock`/`analyze_article` 본문), `_warn`, 타입 예외 2종.
- Produces (Task 2가 사용): `analyze_stock_stream(**기존 analyze_stock과 동일 인자) -> AsyncIterator[str]`, `analyze_article_stream(title, content, is_korean) -> AsyncIterator[str]`. 델타 문자열을 yield하고, 실패 시 기존과 같은 타입 예외(`BedrockUnavailableError`/`BedrockCallError`)를 **제너레이터 밖으로** 던진다. 기존 블로킹 함수들은 이 태스크에서 삭제하지 않는다(라우트가 아직 쓴다 — 삭제는 Task 2).

- [ ] **Step 1: 실패하는 테스트 작성** — `test_bedrock_ai.py`에 추가. 기존 파일의 `_get_client` 모킹 패턴을 그대로 따르되, 스트리밍용 페이크 클라이언트를 쓴다:

```python
class _FakeStreamClient:
    """converse_stream 이벤트 시퀀스를 재생하는 페이크 / A fake replaying a converse_stream event sequence."""

    def __init__(self, events=None, error: Exception | None = None) -> None:
        self.events = events if events is not None else []
        self.error = error
        self.calls: list[dict] = []

    def converse_stream(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return {"stream": iter(self.events)}


def _delta(text: str) -> dict:
    return {"contentBlockDelta": {"delta": {"text": text}}}


async def test_stream_invoke_yields_deltas_in_order(monkeypatch):
    """contentBlockDelta가 순서대로 yield된다 / Deltas come out in order."""
    fake = _FakeStreamClient([_delta("안"), _delta("녕"), {"messageStop": {"stopReason": "end_turn"}}])
    monkeypatch.setattr(bedrock_ai, "_get_client", lambda: fake)

    out = [chunk async for chunk in bedrock_ai.stream_invoke("p", 100)]

    assert out == ["안", "녕"]
    assert fake.calls[0]["modelId"] == config.BEDROCK_MODEL_ID
    assert fake.calls[0]["inferenceConfig"] == {"maxTokens": 100}
    assert fake.calls[0]["messages"] == [{"role": "user", "content": [{"text": "p"}]}]


async def test_stream_invoke_warns_on_max_tokens_stop(monkeypatch, caplog):
    """stopReason max_tokens는 절단 시그널로 경고된다 / A max_tokens stop is warned as a truncation signal."""
    fake = _FakeStreamClient([_delta("x"), {"messageStop": {"stopReason": "max_tokens"}}])
    monkeypatch.setattr(bedrock_ai, "_get_client", lambda: fake)

    with caplog.at_level(logging.WARNING, logger="app.services.bedrock_ai"):
        _ = [c async for c in bedrock_ai.stream_invoke("p", 5)]

    assert any('"ai_stream_truncated"' in r.getMessage() for r in caplog.records)


async def test_stream_invoke_maps_client_errors(monkeypatch):
    """스트림 도중 ClientError는 기존 타입 예외로 매핑된다 / A mid-stream ClientError maps to the typed error."""
    err = ClientError({"Error": {"Code": "AccessDeniedException"}}, "ConverseStream")
    fake = _FakeStreamClient(error=err)
    monkeypatch.setattr(bedrock_ai, "_get_client", lambda: fake)

    with pytest.raises(bedrock_ai.BedrockUnavailableError):
        _ = [c async for c in bedrock_ai.stream_invoke("p", 5)]
```

(기존 파일 상단 import에 없는 것만 추가: `logging`, `pytest`, `ClientError`는 기존 테스트가 이미 쓰는 형태를 따른다.)

- [ ] **Step 2: 실패 확인**

Run: `cd backend && .venv/bin/pytest tests/test_bedrock_ai.py -q -k "stream_invoke"`
Expected: FAIL — `stream_invoke` 미존재(AttributeError).

- [ ] **Step 3: 구현** — `bedrock_ai.py`. `import asyncio`, `import threading`, `from typing import AsyncIterator` 추가 후:

```python
# 스트림 브리지 종료 신호 / End-of-stream sentinels for the bridge queue
_QUEUE_DELTA = "delta"
_QUEUE_STOP = "stop"
_QUEUE_ERROR = "error"
_QUEUE_END = "end"


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

    `stopReason == "max_tokens"`는 진짜 절단 시그널이라 경고로 남긴다 (시나리오별 max_tokens 분리 덕에
    이 로그가 의미를 갖는다). / A max_tokens stop is logged as the truncation signal it is.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def pump() -> None:
        try:
            client = _get_client()
            response = client.converse_stream(
                modelId=config.BEDROCK_MODEL_ID,
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig={"maxTokens": max_tokens},
            )
            for event in response["stream"]:
                text = event.get("contentBlockDelta", {}).get("delta", {}).get("text")
                if text:
                    loop.call_soon_threadsafe(queue.put_nowait, (_QUEUE_DELTA, text))
                stop = event.get("messageStop", {}).get("stopReason")
                if stop is not None:
                    loop.call_soon_threadsafe(queue.put_nowait, (_QUEUE_STOP, stop))
        except Exception as exc:  # noqa: BLE001 - 스레드 경계, 큐로 전달 / thread boundary: forwarded via the queue
            loop.call_soon_threadsafe(queue.put_nowait, (_QUEUE_ERROR, exc))
        else:
            loop.call_soon_threadsafe(queue.put_nowait, (_QUEUE_END, None))

    threading.Thread(target=pump, name="bedrock-stream", daemon=True).start()

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
```

(`_raise_mapped`/`_warn`은 기존 함수 재사용. `_raise_mapped`의 시그니처가 다르면 기존 정의에 맞춰 호출한다 — 매핑 결과가 기존 타입 예외 2종이라는 계약만 지키면 된다.)

- [ ] **Step 4: 프롬프트 조립 분리 + 스트리밍 variant** — `analyze_stock`/`analyze_article`의 프롬프트 조립부를 `_stock_prompt(...) -> str` / `_article_prompt(...) -> str`로 추출하고 (기존 블로킹 함수는 추출된 헬퍼를 쓰도록 변경 — 동작 불변), 다음을 추가:

```python
def analyze_stock_stream(**kwargs) -> AsyncIterator[str]:
    """종목 분석 스트리밍 variant / The streaming variant of analyze_stock."""
    return stream_invoke(_stock_prompt(**kwargs), STOCK_MAX_TOKENS)


def analyze_article_stream(title: str, content: str, is_korean: bool) -> AsyncIterator[str]:
    """기사 분석 스트리밍 variant / The streaming variant of analyze_article."""
    return stream_invoke(_article_prompt(title, content, is_korean), ARTICLE_MAX_TOKENS)
```

프롬프트 조립 중 예외(잘못된 입력)는 기존 `_raise_mapped` 경로와 같은 타입 예외가 되도록, 조립을 `stream_invoke` 호출 전에 try로 감싸 기존 매핑을 적용한다 (기존 `analyze_*`가 하던 방식과 동일하게).

- [ ] **Step 5: 전체 테스트 통과 확인**

Run: `cd backend && .venv/bin/pytest -q`
Expected: 전체 PASS (302 + 신규 3+ = 305+). 기존 `analyze_*` 테스트는 프롬프트 추출 후에도 그대로 PASS(동작 불변).

- [ ] **Step 6: 커밋**

```bash
git add backend/app/services/bedrock_ai.py backend/tests/test_bedrock_ai.py
git commit -m "feat(backend): converse_stream primitive with thread-to-queue bridge"
```

---

### Task 2: SSE 라우트 전환 + `TieredCache.peek` + 백엔드 테스트 개편

**Files:**
- Modify: `backend/app/cache/tiered.py` / Test: `backend/tests/test_cache_tiered.py`
- Modify: `backend/app/api/ai.py`, `backend/app/services/bedrock_ai.py`(구 블로킹 함수 삭제)
- Test: `backend/tests/test_api_ai.py`, `backend/tests/test_bedrock_ai.py`(구 함수 테스트 삭제)

**Interfaces:**
- Consumes: Task 1의 `analyze_stock_stream`/`analyze_article_stream`, 기존 `rate_limited`/`get_semaphore`/`get_fetch_semaphore`/`envelope`/`key_*`/`DETAIL_*`.
- Produces: 두 POST 엔드포인트가 `text/event-stream` 응답(스펙 §2 프로토콜). `TieredCache.peek(key) -> Optional[Tuple[Any, str]]` (L1→L2 조회·L1 승격, 미스면 None, fetch 없음).

- [ ] **Step 1: peek의 실패하는 테스트** — `test_cache_tiered.py`에 (기존 픽스처 패턴 사용): ① L1 히트 반환 ② L1 미스·L2 히트 시 값 반환 + L1 승격 확인 ③ 양쪽 미스면 None ④ peek은 fetcher를 부르지 않는다.

- [ ] **Step 2: 실패 확인** — `pytest tests/test_cache_tiered.py -q -k peek` → AttributeError FAIL.

- [ ] **Step 3: peek 구현** — `tiered.py`: `get_or_fetch`의 L1→L2 조회·승격 부분과 동일한 로직을 락 없이 수행하는 `async def peek(self, key)`. 주석: SSE 라우트가 "히트면 final 하나" 판단에 쓰며, 미스 후 경합은 라우트의 inflight 레지스트리가 처리하므로 락이 필요 없다.

- [ ] **Step 4: peek 테스트 통과 확인** 후 여기서 1차 커밋:

```bash
git add backend/app/cache/tiered.py backend/tests/test_cache_tiered.py
git commit -m "feat(backend): TieredCache.peek for lock-free cache probes"
```

- [ ] **Step 5: SSE 라우트의 실패하는 테스트** — `test_api_ai.py` 개편. 먼저 파일 상단에 SSE 파싱 헬퍼:

```python
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
```

`FakeBedrock`에 스트리밍 페이크 추가 — 새 속성 `stream_deltas: list[str]`(기본값: 기존 `STOCK_ANALYSIS`/`ARTICLE_ANALYSIS`를 2-3조각으로 나눈 리스트 — 기존 테스트의 "최종 텍스트" 단정이 join 결과와 일치하도록)과 `stream_error: Exception | None`(설정 시 델타 일부를 낸 **뒤** raise — mid-stream 실패 재현). `analyze_stock_stream`/`analyze_article_stream`은 async generator: 기존 `self.error`가 설정돼 있으면 첫 델타 **전에** raise, 아니면 `stream_deltas`를 순서대로 yield (사이에 `self.delay`가 있으면 `await asyncio.sleep`), in-flight 카운터는 기존 `_enter/_exit` 재사용. `bedrock` 픽스처의 monkeypatch 대상도 스트리밍 함수 2종으로 교체.

핵심 신규 테스트 (각각 하나의 행동):

```python
async def test_stock_stream_emits_phase_deltas_then_final(state, services, bedrock):
    """주식 스트림: phase → delta* → final, 델타 합 == 최종 분석 / phase, deltas, then a final whose analysis equals the joined deltas."""
    bedrock.stream_deltas = ["## 분석", "\n첫 ", "문단"]
    app = create_app(state)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as async_client:
        response = await async_client.post(
            f"/api/ai/stocks/{US_SYMBOL}", headers={"X-Forwarded-For": "10.9.9.1"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _sse_events(response.text)
    assert events[0] == ("phase", {"phase": "analyzing"})
    deltas = [d["text"] for name, d in events if name == "delta"]
    assert deltas == bedrock.stream_deltas
    name, final = events[-1]
    assert name == "final"
    assert final["data"]["analysis"] == "".join(bedrock.stream_deltas)
    assert set(final) == {"asOf", "marketOpen", "data"}   # 기존 envelope 형태 / the existing envelope shape

async def test_article_stream_starts_with_fetching_phase(state, bedrock): ...

async def test_cache_hit_emits_final_only(state, services, bedrock): ...
    # 같은 요청 2회 — 두 번째 응답의 이벤트가 final 하나뿐, Bedrock 스트림 호출 1회

async def test_midstream_error_still_emits_final_with_error(state, services, bedrock): ...
    # bedrock.stream_error 설정 → 마지막 이벤트가 final {"error": "ai_failed", "status": 500}

async def test_article_unavailable_maps_to_final_502(state, bedrock): ...
    # fetch가 "" → final {"error": "article_unavailable", "status": 502}

async def test_follower_gets_waiting_heartbeat_then_final(state, services, bedrock): ...
    # bedrock.delay로 선점자를 늦추고 같은 키 동시 요청 → 팔로워 이벤트에 phase waiting ≥ 1회 + final
    # (하트비트 간격은 테스트에서 짧게 monkeypatch — 아래 Step 6의 HEARTBEAT_SECONDS)

async def test_rate_limit_stays_json_429(state, services, bedrock): ...
    # 4번째 요청이 429 JSON (SSE 아님) — 기존 테스트 유지·개명이어도 좋다
```

**기존 테스트 개편 원칙** (파일 전체에 적용, 리뷰어가 검증할 계약): JSON 응답을 단정하던 모든 테스트는 `_sse_events(response.text)`의 **final 이벤트 data**에 같은 단정을 적용한다. 보존해야 할 기존 행동 전부: 레이트리밋(IP별·429)·캐시 TTL·같은 키 동시 요청 시 Bedrock 1회·세마포어 상한 2종(`max_in_flight`, `max_fetch_in_flight`)·422 검증·오류 코드 3종(503/500/502) 구분·detail 오버레이 가격 사용. 삭제되는 것: 구 블로킹 `analyze_*`/`invoke_bedrock`/`cached_analysis` 직접 단정 테스트(행동이 스트림 경로로 승계).

- [ ] **Step 6: 실패 확인** — 신규 테스트가 FAIL (엔드포인트가 아직 JSON).

- [ ] **Step 7: 라우트 구현** — `ai.py`:

1. 상수·헬퍼:

```python
# 팔로워 하트비트 간격 (초) — CloudFront idle 리셋용. 테스트가 짧게 monkeypatch한다.
# Follower heartbeat period (seconds), resetting the CloudFront idle counter; tests shrink it.
HEARTBEAT_SECONDS = 5.0


def _sse(event: str, data: dict) -> bytes:
    """SSE 프레임 하나 / One SSE frame."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


def get_inflight(request: Request) -> dict:
    """진행 중 스트림 레지스트리 (앱 단위, 첫 요청에서 생성) / The per-app in-flight stream registry."""
    registry = getattr(request.app.state, "ai_inflight", None)
    if registry is None:
        registry = {}
        request.app.state.ai_inflight = registry
    return registry
```

2. 공통 스트림 골격 — 두 라우트가 공유하는 async generator 함수 `def _analysis_stream(state, inflight, key, first_phase, produce) -> AsyncIterator[bytes]`. `produce`는 `Callable[[], AsyncIterator[str | tuple]]`… 대신 **명료성을 위해 라우트별 제너레이터를 각각 두되 아래 골격을 공유 헬퍼로 뽑을지는 구현자가 중복을 보고 판단** (두 라우트의 차이는 fetching phase와 입력 수집뿐). 골격 (기사 라우트 기준, 전 코드):

```python
async def events() -> AsyncIterator[bytes]:
    data: Optional[dict] = None
    as_of: Optional[str] = None
    try:
        yield _sse("phase", {"phase": "fetching"})

        cached = await state.cache.peek(key)
        if cached is not None:
            data, as_of = cached
        else:
            fut = inflight.get(key)
            if fut is not None:
                # 팔로워: 선점자를 기다리며 하트비트 / Follower: heartbeat while the leader works
                while True:
                    done, _pending = await asyncio.wait([fut], timeout=HEARTBEAT_SECONDS)
                    if done:
                        break
                    yield _sse("phase", {"phase": "waiting"})
                outcome = fut.result()   # ("ok", data, as_of) | ("error", detail, status)
                if outcome[0] == "error":
                    yield _sse("final", {"error": outcome[1], "status": outcome[2]})
                    return
                _tag, data, as_of = outcome
            else:
                # 선점자 / Leader
                fut = asyncio.get_running_loop().create_future()
                inflight[key] = fut
                try:
                    async with fetch_semaphore:
                        content = await news.fetch_article_content(payload.url)
                    if not content:
                        _warn("ai_article_content_empty", url=payload.url)
                        raise HTTPException(status_code=502, detail=DETAIL_ARTICLE_UNAVAILABLE)

                    yield _sse("phase", {"phase": "analyzing"})
                    parts: list[str] = []
                    async with semaphore:
                        try:
                            stream = bedrock_ai.analyze_article_stream(
                                payload.title, content, payload.language == "ko")
                            async for delta in stream:
                                parts.append(delta)
                                yield _sse("delta", {"text": delta})
                        except Exception:
                            state.mark_source(SOURCE_BEDROCK, STATUS_DEGRADED)
                            raise
                    state.mark_source(SOURCE_BEDROCK, STATUS_OK)

                    data = {"url": payload.url, "title": payload.title,
                            "language": payload.language, "analysis": "".join(parts)}
                    await state.cache.put(key, data, config.AI_TTL)
                    peeked = await state.cache.peek(key)   # put이 찍은 asOf를 그대로 쓴다
                    as_of = peeked[1] if peeked is not None else deps.now_iso()
                    fut.set_result(("ok", data, as_of))
                except HTTPException as exc:
                    fut.set_result(("error", exc.detail, exc.status_code))
                    raise
                except bedrock_ai.BedrockUnavailableError as exc:
                    _warn("ai_unavailable", key=key, error=str(exc))
                    fut.set_result(("error", DETAIL_AI_UNAVAILABLE, 503))
                    yield _sse("final", {"error": DETAIL_AI_UNAVAILABLE, "status": 503})
                    return
                except Exception as exc:
                    # 스택 트레이스는 운영 원인 추적용 — 단일 라인 JSON 규칙의 의도적 예외
                    # The stack trace is for operational root-causing - a deliberate exception to the one-line-JSON rule
                    logger.exception("ai stream failed key=%s", key)
                    _warn("ai_failed", key=key, error=str(exc), error_type=type(exc).__name__)
                    fut.set_result(("error", DETAIL_AI_FAILED, 500))
                    yield _sse("final", {"error": DETAIL_AI_FAILED, "status": 500})
                    return
                finally:
                    inflight.pop(key, None)

        yield _sse("final", envelope(data, deps.market_open_now(), as_of))
    except HTTPException as exc:
        yield _sse("final", {"error": exc.detail, "status": exc.status_code})
```

주의점(구현자·리뷰어 공통 체크): ① `fut`에는 **예외를 넣지 않는다** — 팔로워가 없을 때 "exception never retrieved" 경고가 나므로 튜플 결과만 쓴다. ② `inflight.pop`은 finally에서. ③ peek→inflight 검사→등록 사이에 await가 없어야 원자적이다(단일 이벤트 루프) — `peek`의 await 이후 등록 전에 다른 코루틴이 끼어들 수 있으므로 **등록 직전에 inflight를 재확인**한다. ④ `envelope`/`deps.now_iso` 등 실제 헬퍼 이름은 파일에 있는 것을 쓴다(없는 이름을 새로 만들지 않는다 — as_of가 put과 다른 소스면 스트림 응답과 캐시 응답의 asOf가 어긋난다).

3. 라우트 반환:

```python
return StreamingResponse(
    events(), media_type="text/event-stream",
    headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
)
```

4. 주식 라우트: 동일 골격에서 `fetching` phase 없이 시작하되 **첫 이벤트로 `phase: analyzing`을 즉시 emit**, 입력 수집(오버레이된 detail + `recent_news_titles`)은 기존 build 로직 그대로 phase 뒤에. fetch 세마포어 없음(기사 전용).
5. 죽은 코드 제거: `cached_analysis`, `invoke_bedrock`, `bedrock_ai._invoke`/`analyze_stock`/`analyze_article`(블로킹) — 저장소 전체 grep으로 참조 0 확인 후 삭제.

- [ ] **Step 8: 전체 테스트 통과 확인** — `pytest -q` 전체 그린 + `oxlint` 해당 없음(백엔드).

- [ ] **Step 9: 커밋**

```bash
git add backend/app/api/ai.py backend/app/services/bedrock_ai.py backend/tests/test_api_ai.py backend/tests/test_bedrock_ai.py
git commit -m "feat(backend): SSE streaming AI routes (phase/delta/final) with leader-follower cache"
```

---

### Task 3: 프론트 SSE 파서 + 스트리밍 훅

**Files:**
- Create: `frontend/src/lib/sse.ts` / Test: `frontend/src/lib/sse.test.ts`
- Create: `frontend/src/api/aiStream.ts` / Test: `frontend/src/api/aiStream.test.ts`
- Modify: `frontend/src/api/queries.ts` (구 `useStockAI`/`useArticleAI` 삭제 — 사용처 교체는 Task 4에서 하므로, 이 태스크에서는 **삭제하지 않고 유지**; 삭제는 Task 4)

**Interfaces:**
- Consumes: 백엔드 SSE 프로토콜(Global Constraints의 이벤트 3종), 기존 `ApiError`(`client.ts` — 상태·detail 기반, `aiMessages.ts`가 소비).
- Produces (Task 4가 사용):
  - `createSseParser(): { feed(chunk: string): SseEvent[] }` — 증분 파서, `SseEvent = { event: string; data: string }`.
  - `useStockAIStream(symbol): AiStream<StockAnalysis>` / `useArticleAIStream(): AiStream<ArticleAnalysis, ArticleAnalysisRequest>` — 형태:

```ts
export interface AiStream<TData, TBody = void> {
  /** 진행 단계 — 스트림 전/후엔 null / The phase; null before and after the stream */
  phase: 'fetching' | 'analyzing' | 'waiting' | null
  /** 누적 스트리밍 텍스트 (delta 합류) / Accumulated streamed text */
  streamText: string
  data: TData | undefined
  asOf: string | undefined
  isLoading: boolean
  error: ApiError | null
  analyze: (body: TBody) => void
}
```

- [ ] **Step 1: 파서의 실패하는 테스트** — `sse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createSseParser } from './sse.ts'

describe('createSseParser', () => {
  it('완전한 프레임 하나를 파싱한다 / parses one complete frame', () => {
    const p = createSseParser()
    expect(p.feed('event: delta\ndata: {"text":"a"}\n\n')).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
    ])
  })

  it('청크 경계에서 잘린 프레임을 이어 붙인다 / stitches a frame split across chunks', () => {
    const p = createSseParser()
    expect(p.feed('event: delta\nda')).toEqual([])
    expect(p.feed('ta: {"text":"a"}\n\n')).toEqual([{ event: 'delta', data: '{"text":"a"}' }])
  })

  it('한 청크의 여러 프레임을 모두 반환한다 / returns every frame in one chunk', () => {
    const p = createSseParser()
    const frames = p.feed('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')
    expect(frames.map((f) => f.event)).toEqual(['a', 'b'])
  })

  it('멀티라인 data를 개행으로 합친다 / joins multi-line data with newlines', () => {
    const p = createSseParser()
    expect(p.feed('event: x\ndata: 1\ndata: 2\n\n')).toEqual([{ event: 'x', data: '1\n2' }])
  })

  it('CRLF도 처리한다 / handles CRLF', () => {
    const p = createSseParser()
    expect(p.feed('event: x\r\ndata: 1\r\n\r\n')).toEqual([{ event: 'x', data: '1' }])
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/sse.test.ts` → 모듈 없음 FAIL.

- [ ] **Step 3: 파서 구현** — `sse.ts` (네트워크 무관 순수 함수):

```ts
/**
 * 증분 SSE 프레임 파서 — fetch ReadableStream 청크는 프레임 경계와 무관하게 잘린다.
 * An incremental SSE frame parser; fetch stream chunks split anywhere, not at frame boundaries.
 * (EventSource는 GET 전용이라 POST SSE는 직접 파싱한다 / EventSource is GET-only, so POST SSE is parsed by hand.)
 */
export interface SseEvent {
  event: string
  data: string
}

export function createSseParser(): { feed(chunk: string): SseEvent[] } {
  let buffer = ''
  return {
    feed(chunk: string): SseEvent[] {
      buffer += chunk.replace(/\r\n/g, '\n')
      const events: SseEvent[] = []
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) data.push(line.slice(6))
        }
        if (data.length > 0) events.push({ event, data: data.join('\n') })
        boundary = buffer.indexOf('\n\n')
      }
      return events
    },
  }
}
```

- [ ] **Step 4: 훅의 실패하는 테스트** — `aiStream.test.ts`: `fetch`를 모킹해 `ReadableStream`으로 SSE 바이트를 흘리고(테스트 헬퍼로 `new Response(stream, {status:200})`), `renderHook`으로: ① delta 누적이 `streamText`에 반영 ② final 성공 시 `data`/`asOf` 설정·`isLoading` false·`streamText` 유지 또는 초기화(구현 선택을 테스트로 고정: **final 후 streamText는 그대로 두고 data가 우선**) ③ final `{"error","status"}` 시 `error`가 기존 `ApiError` 형태(=`aiErrorMessage`가 매핑 가능) ④ HTTP 429 JSON 응답이면 스트림 파싱 없이 `ApiError(429)`.

- [ ] **Step 5: 실패 확인** 후 **Step 6: 훅 구현** — `aiStream.ts`:

핵심 계약 (코드 전문은 구현자가 작성하되 아래를 지킨다):
- `fetch(url, { method: 'POST', headers, body })` → `response.ok`가 아니고 `content-type`이 JSON이면 기존 `ApiError`로 (429 경로). `text/event-stream`이면 `response.body.getReader()` + `TextDecoder` 루프 → `createSseParser().feed()` → 이벤트 스위치.
- `final`에 `error`가 있으면 `ApiError(status, detail)` 구성 — **기존 `client.ts`의 ApiError 클래스를 재사용**해 `aiMessages.ts` 매핑이 그대로 동작.
- 상태 갱신은 React state (`useState` + `useRef`로 누적 버퍼); 언마운트 시 `reader.cancel()` (`useEffect` cleanup).
- 파일 상단 주석에 **react-query 규칙 예외 사유**: "SSE는 react-query가 지원하지 않는 점진적 응답이라 이 훅만 fetch를 직접 쓴다 — 나머지 서버 상태는 계속 react-query" (한/영).

- [ ] **Step 7: 전체 프론트 테스트 통과** — `npx vitest run` (116 + 신규). `npx oxlint`, `npx tsc -b` 클린.

- [ ] **Step 8: 커밋**

```bash
git add frontend/src/lib/sse.ts frontend/src/lib/sse.test.ts frontend/src/api/aiStream.ts frontend/src/api/aiStream.test.ts
git commit -m "feat(frontend): SSE parser and streaming AI hooks"
```

---

### Task 4: UI 실시간 렌더 + remark-gfm + 구 경로 제거

**Files:**
- Modify: `frontend/src/components/stock/AIPanel.tsx` / Test: 신규 `frontend/src/components/stock/AIPanel.test.tsx`
- Modify: `frontend/src/pages/ArticleAnalysis.tsx` / Test: 기존 `ArticleAnalysis.test.tsx` 갱신
- Modify: `frontend/src/api/queries.ts` (구 `useStockAI`/`useArticleAI` 삭제), `frontend/package.json`(remark-gfm), `frontend/src/styles/global.css`(.markdown 표/코드 스타일)

**Interfaces:**
- Consumes: Task 3의 `useStockAIStream`/`useArticleAIStream` (AiStream 형태), `aiErrorMessage`(불변).
- Produces: 사용자 가시 동작 — 분석 중 토큰 실시간 렌더 + phase 라벨, GFM 표 렌더.

- [ ] **Step 1: 설치** — `cd frontend && npm i remark-gfm@^4`

- [ ] **Step 2: 실패하는 테스트** — `AIPanel.test.tsx` (신규): 스트리밍 훅을 모킹해 ① `isLoading && streamText`면 누적 텍스트가 마크다운으로 렌더되고 스피너 문구 대신 진행 표시 ② phase 라벨(분석 준비 중/본문 가져오는 중/대기 중) ③ final 후 `data.analysis` 렌더 ④ GFM 표(`| a | b |...`)가 `<table>`로 렌더(remark-gfm 적용 증명) ⑤ error 시 기존 `aiErrorMessage` 문구. `ArticleAnalysis.test.tsx`: 기존 단정을 스트리밍 훅 모킹으로 이전 (기존 보존 행동: URL 폼 검증·오류 문구·성공 렌더).

- [ ] **Step 3: 실패 확인** → **Step 4: 구현**:
- 두 컴포넌트 모두 `Markdown` → `<Markdown remarkPlugins={[remarkGfm]}>`; 렌더 소스는 `data?.analysis ?? streamText`(final이 도착하면 권위 있는 최종본이 우선 — 스펙 §2).
- 로딩 분기: `isLoading && streamText === ''` → 기존 스피너 + phase 라벨(`fetching`→"본문을 가져오는 중…", `waiting`→"다른 요청의 결과를 기다리는 중…", `analyzing`→"분석 중…"); `isLoading && streamText !== ''` → 실시간 마크다운(스피너 없음, 커서 느낌의 진행 인디케이터는 CSS `::after`로 선택 사항 — 넣으면 `prefers-reduced-motion` 처리).
- `queries.ts`의 구 훅 2개 삭제 + repo 전체 grep으로 참조 0 확인.
- `global.css`의 `.markdown`에 GFM 표 스타일 (tokens만):

```css
.markdown table {
  margin: 8px 0;
  border-collapse: collapse;
  font-size: 13px;
}

.markdown th,
.markdown td {
  padding: 6px 10px;
  text-align: left;
  border: 1px solid var(--bg);
}

.markdown th {
  color: var(--text-strong);
  background: var(--bg);
}
```

(기존 `.markdown` 블록의 서식과 이웃 규칙 순서를 따른다. `--text-strong`/`--bg`가 실재하는지 tokens.css에서 확인하고 없으면 실재하는 근접 토큰 사용.)

- [ ] **Step 5: 전체 프론트 테스트 + 린트 + 타입 체크** — `npx vitest run`, `npx oxlint`, `npx tsc -b` 전부 클린.

- [ ] **Step 6: 커밋**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src
git commit -m "feat(frontend): live streaming AI panels with remark-gfm markdown"
```

---

### Task 5: 로컬 E2E 검증

**Files:** 수정 없음이 기대값 (발견 문제만 수정 — CSS/문구 한정, 구조 변경은 BLOCKED 보고). 스크린샷·로그는 스크래치패드에.

**Interfaces:**
- Consumes: Tasks 1-4 전부, `make run`(:8000), 실제 Bedrock 자격 증명(이 EC2에 있음 — 실호출 2건은 승인된 검증 비용).

- [ ] **Step 1:** `make run` 기동, `curl -s localhost:8000/api/health` ok 확인.
- [ ] **Step 2:** `curl -N -X POST localhost:8000/api/ai/stocks/AAPL`로 SSE 원문 관찰 — 첫 이벤트가 1초 내 `phase`, `delta` 다수, 마지막 `final`(envelope). 첫 delta 도착 시간 기록.
- [ ] **Step 3:** 실기사 1건으로 `curl -N -X POST localhost:8000/api/ai/articles ...` — `fetching`→`analyzing`→delta→final. 같은 요청 재실행 → `final` 단독(캐시 히트) 즉시.
- [ ] **Step 4:** Playwright(스크래치패드 `pw/`의 chromium)로 종목 상세 페이지에서 AI 분석 버튼 → 텍스트가 점진 표시되는 스크린샷 2장(초기/완료), GFM 표가 있는 분석이면 표 렌더 확인.
- [ ] **Step 5:** 회귀 — `cd backend && .venv/bin/pytest -q` + `cd frontend && npx vitest run` 전체 그린. uvicorn 종료.
- [ ] **Step 6:** 발견 문제 수정이 있었으면 커밋, 없으면 "검증 결과만 보고".

### Task 6: 분석 불가 뉴스 링크는 원문 새 탭으로 (KR 종목뉴스 라이브 버그)

**Files:**
- Create: `frontend/src/lib/articleLink.ts` / Test: `frontend/src/lib/articleLink.test.ts`
- Modify: `frontend/src/components/stock/StockNews.tsx`, `frontend/src/components/market/NewsFeed.tsx`
- Test: 신규 `frontend/src/components/stock/StockNews.test.tsx` (또는 두 컴포넌트 공용 테스트)

**배경 (라이브 재현, 2026-08-03):** KR 종목뉴스는 `_company_feed`가 Google News 검색 RSS를 쓰므로
링크가 `news.google.com/rss/articles/<opaque>?oc=5` 래퍼다. 이 URL은 실기사가 아니라 Google JS
셸로 302되어(브라우저 확인) 본문 추출이 빈 결과 → `POST /api/ai/articles`가 502
`article_unavailable`. 화면은 "기사 본문을 가져올 수 없습니다"만 남아 사용자에겐 "응답 없음"으로
보인다. US(Yahoo 직접 URL)·시장 뉴스 대부분은 정상. 이 태스크는 SSE와 무관하지만 같은 화면군의
프론트 수정이라 이 브랜치 배포에 함께 태운다.

**사용자 결정 (2026-08-03):** 분석 불가 링크는 `/articles`로 라우팅하지 않고 **원문을 새 탭으로
열고** 짧은 안내를 보인다 (외부 의존·백엔드 변경 없음).

**Interfaces:**
- Consumes: `NewsItem`(`api/types.ts` — `link`/`title`/`language`/`source`).
- Produces: `isAnalyzable(item: NewsItem): boolean` (원문 URL을 직접 얻을 수 있어 분석 가능한지),
  `articleHref(item): string` (분석 화면 링크 — 기존 두 컴포넌트의 중복 함수를 여기로 통합).

- [ ] **Step 1: 실패하는 테스트** — `articleLink.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isAnalyzable, articleHref } from './articleLink.ts'
import type { NewsItem } from '../api/types.ts'

const item = (over: Partial<NewsItem>): NewsItem => ({
  id: 'x', title: '제목', link: 'https://example.com/a', source: 'Yahoo',
  published: '', language: 'en', ...over,
})

describe('isAnalyzable', () => {
  it('직접 기사 URL은 분석 가능 / a direct article URL is analyzable', () => {
    expect(isAnalyzable(item({ link: 'https://finance.yahoo.com/news/x.html' }))).toBe(true)
  })
  it('Google News 래퍼는 분석 불가 / a Google News wrapper is not analyzable', () => {
    expect(isAnalyzable(item({ link: 'https://news.google.com/rss/articles/CBMiabc?oc=5' }))).toBe(false)
  })
  it('news.google.com 하위 도메인/경로 변형도 불가 / other news.google.com shapes are excluded too', () => {
    expect(isAnalyzable(item({ link: 'https://news.google.com/articles/abc' }))).toBe(false)
  })
  it('잘못된 URL은 분석 불가 (throw 금지) / a malformed URL is not analyzable and does not throw', () => {
    expect(isAnalyzable(item({ link: 'not a url' }))).toBe(false)
  })
})

describe('articleHref', () => {
  it('url·title·language를 쿼리로 싣는다 / carries url, title and language as query params', () => {
    const href = articleHref(item({ link: 'https://x.com/a', title: 'T', language: 'ko' }))
    const q = new URL(href, 'http://h').searchParams
    expect([q.get('url'), q.get('title'), q.get('language')]).toEqual(['https://x.com/a', 'T', 'ko'])
  })
})
```

- [ ] **Step 2: 실패 확인** — `npx vitest run src/lib/articleLink.test.ts` → 모듈 없음 FAIL.

- [ ] **Step 3: 구현** — `articleLink.ts`:

```ts
/**
 * 뉴스 링크 유틸 — 분석 가능 판정 + 분석 화면 링크. StockNews·NewsFeed가 공유한다.
 * News-link helpers: the analyzable test and the analysis-screen link, shared by StockNews and NewsFeed.
 *
 * KR 종목뉴스는 Google News 검색 RSS라 링크가 `news.google.com/...` 래퍼다 — 실기사가 아니라
 * Google JS 셸로 리다이렉트되어 본문 추출이 불가능하다 (백엔드가 502 article_unavailable). 그래서
 * 이런 링크는 분석 화면 대신 원문 새 탭으로 연다 (2026-08-03 라이브 버그 수정).
 * KR per-symbol news comes from Google News search RSS, so its links are `news.google.com/...` wrappers
 * that redirect to a Google JS shell rather than the real article — extraction cannot work (the backend
 * returns 502 article_unavailable). Such links open the source in a new tab instead of the analysis
 * screen (live-bug fix 2026-08-03).
 */
import type { NewsItem } from '../api/types.ts'

/** 본문 추출이 불가능한 호스트 / Hosts whose links cannot be extracted */
const UNANALYZABLE_HOSTS = new Set(['news.google.com'])

export function isAnalyzable(item: NewsItem): boolean {
  try {
    return !UNANALYZABLE_HOSTS.has(new URL(item.link).hostname)
  } catch {
    return false   // URL 파싱 실패 = 분석 대상 아님 / an unparseable URL is not analyzable
  }
}

export function articleHref(item: NewsItem): string {
  const params = new URLSearchParams({ url: item.link, title: item.title, language: item.language })
  return `/articles?${params.toString()}`
}
```

- [ ] **Step 4: 컴포넌트 적용** — `StockNews.tsx`·`NewsFeed.tsx`의 로컬 `articleHref`를 삭제하고
  `articleLink.ts`에서 import. 목록 항목 렌더를 분기: `isAnalyzable(item)`이면 기존 `<Link
  to={articleHref(item)}>`, 아니면 원문 새 탭 `<a href={item.link} target="_blank"
  rel="noreferrer">` + 같은 `.news-item` 스타일 + 분석 불가 안내 표식(예: `news-meta`에 "원문 보기"
  추가). 시각·접근성은 기존 항목과 동일 클래스 재사용.

- [ ] **Step 5: 컴포넌트 테스트** — `StockNews.test.tsx`: `useStockNews`를 모킹해 ① Google News 링크
  항목은 `<a target="_blank" rel="noreferrer" href={원문}>`로 렌더되고 `/articles` `<Link>`가 아님
  ② 직접 URL 항목은 기존대로 `/articles` 링크. (NewsFeed도 같은 패턴이면 한 파일에서 함께 검증하거나
  별도 파일 — 구현자 판단, 단 두 컴포넌트의 분기가 실제로 테스트되어야 한다.)

- [ ] **Step 6: 전체 프론트 테스트 + 린트 + 타입 체크** — `npx vitest run`, `npx oxlint`, `npx tsc -b` 클린.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/lib/articleLink.ts frontend/src/lib/articleLink.test.ts frontend/src/components/stock/StockNews.tsx frontend/src/components/stock/StockNews.test.tsx frontend/src/components/market/NewsFeed.tsx
git commit -m "fix(frontend): open unanalyzable (Google News) links in a new tab instead of the analysis screen"
```

---

## 완료 후 (플랜 밖, 컨트롤러 몫)

최종 브랜치 리뷰 → 사용자 배포(`cdk deploy`는 이미지 재빌드 포함) → 라이브 SSE 검증(CloudFront 경유 `curl -N`으로 delta 흐름·30초 초과 스트림 생존 확인).
