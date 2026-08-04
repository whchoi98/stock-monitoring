# AI 분석 SSE 스트리밍 + 마크다운 렌더링 개선 — 설계 스펙

- 날짜: 2026-08-03 (사용자 승인)
- 배경: 콜드 기사 분석이 ~45초(번역+2048토큰 생성)로, CloudFront origin read timeout을 60초로
  올려 첫 요청 504는 해소했으나 (커밋 1b81c5a1) ① wall-clock 상한에 여전히 결박되어 있고
  ② 사용자는 45초 동안 스피너만 본다. SSE 스트리밍은 두 문제를 동시에 해결한다: delta 이벤트가
  CloudFront idle 카운터를 리셋해 wall-clock 제약이 사라지고, 토큰이 생기는 즉시 화면에 흐른다.

## 사용자 결정 (2026-08-03)

| 결정 | 선택 |
|---|---|
| 적용 범위 | **주식+기사 두 AI 엔드포인트 모두** converse_stream 전환 |
| 프로토콜 | **전면 SSE 전환** — 기존 POST 엔드포인트가 `text/event-stream` 응답 (프론트 SPA가 유일한 클라이언트, JSON 이중 모드 없음) |
| 범위 한정 | **스트리밍 개선 + 마크다운 렌더링 개선만**. AgentCore/simulateStreaming 불사용 (converse_stream이 실제 토큰 스트리밍이므로 타이핑 시뮬레이션 불필요) |

## 1. 백엔드 — Bedrock 스트리밍 (`services/bedrock_ai.py`)

- `invoke_model`(블로킹 JSON) → **`converse_stream`** 전환. `contentBlockDelta` 이벤트마다 텍스트
  델타를 즉시 내보내는 스트리밍 프리미티브로 교체한다.
- boto3 이벤트 스트림은 **동기**다: 전용 스레드가 이벤트를 읽어 `loop.call_soon_threadsafe`로
  `asyncio.Queue`에 밀어 넣고, async 제너레이터가 큐에서 꺼내 yield한다 — 이벤트 루프 비차단.
- `max_tokens` 시나리오 분리 유지: `ARTICLE_MAX_TOKENS = 2048`, `STOCK_MAX_TOKENS = 1024`.
  일률 상한을 두지 않는 이유: (a) 응답 길이 예측 가능 (b) Bedrock 비용 측정이 깨끗
  (c) `stop_reason == "max_tokens"`가 진짜 절단 시그널이 된다.
- **`stop_reason` 로깅**: `messageStop`의 stopReason이 `max_tokens`면 `_warn`(단일 라인 JSON)으로
  기록 — 절단 감지 운영 시그널.
- 기존 타입 예외(`BedrockUnavailableError`/`BedrockCallError`) 매핑 유지. 스트림 도중 예외는
  제너레이터 밖으로 전파되어 라우트의 final-예외 처리로 들어간다.
- 프롬프트 조립(analyze_stock/analyze_article의 내용)은 불변 — 호출 프리미티브만 바뀐다.

## 2. 백엔드 — SSE 라우트 (`api/ai.py`, 두 엔드포인트)

### 이벤트 프로토콜 (text/event-stream)
```
event: phase   data: {"phase": "fetching" | "analyzing" | "waiting"}
event: delta   data: {"text": "<토큰 청크>"}
event: final   data: {"asOf", "marketOpen", "data": {...기존 envelope와 동일...}}
               또는  {"error": "<기존 DETAIL_* 문구>", "status": <기존 HTTP 코드>}
```
- **첫 이벤트는 즉시 emit** (기사: `fetching`, 주식: `analyzing`) — TTFB ~0초로 CloudFront idle
  카운터 리셋이 시작된다. 이후 delta 하나하나가 카운터를 리셋하므로 30/60s wall-clock 제약이
  사라진다.
- **`final`은 항상 emit** (전체를 try/except로 감싼다): 예외 시에도 `final`에 기존 오류
  문구(`ai_unavailable`/`ai_failed`/`article_unavailable` 등)와 대응 status를 실어 보내고, 스택
  트레이스는 서버 로그(CloudWatch)로 남긴다. SSE의 최다 운영 이슈 — "mid-stream 예외 시
  클라이언트는 connection close만 보고 끝났는지 죽었는지 모름" — 를 차단한다.
- 레이트리밋 초과는 스트림 시작 전이므로 기존대로 429 JSON 응답 유지 (SSE 아님).

### 캐시·동시성 상호작용
- **캐시 히트**: 즉시 `final` 하나만 emit (같은 SSE 형식 — 프론트 코드 경로 단일).
  (정정 2026-08-04: 위 "첫 이벤트는 즉시 emit"이 캐시 프로브에 선행하므로(TTFB 0) 실제 캐시 히트는
  `phase 1개 + final`이다 — 테스트 `test_cache_hit_emits_the_first_phase_then_final_only`가 이 동작을 고정한다.)
- **캐시 미스(선점자)**: 키 락 획득 → 재확인 → 스트리밍하며 텍스트 누적 → 완료 시 기존 캐시에
  저장(`AI_TTL` 불변) → `final`.
- **팔로워** (같은 키 동시 요청): 락 대기 동안 `phase: waiting`을 ~5초 간격 하트비트로 emit
  (타임아웃 방지), 선점자 완료 후 캐시에서 `final`.
- 세마포어 불변: 기사 fetch는 `AI_FETCH_CONCURRENCY`, Bedrock 스트림 생성은
  `AI_GLOBAL_CONCURRENCY` 세마포어를 스트림 완료까지 보유 (현재와 동일한 동시성 의미).

### 인프라 (변경 0 — 확인 사항만)
- Lambda@Edge 없음 — 특히 ORIGIN_RESPONSE 단계가 없어서 응답 body 버퍼링으로 SSE chunked
  transfer가 깨지는 문제가 원천적으로 없다 (검증은 Viewer 요청 단계의 헤더/SG로만 수행,
  응답 변형 0).
- CloudFront는 POST 응답을 캐시하지 않는다 — SSE 응답 캐시 오염 없음.
- origin read timeout 60초(1b81c5a1)는 belt-and-braces로 **유지** — delta가 리셋하므로 실질
  제약은 아니다.
- ALB HTTP/1.1 chunked 통과, idle 60초도 청크마다 리셋.

## 3. 프론트엔드 — 스트리밍 소비 + 마크다운

- `EventSource`는 GET 전용이므로 **fetch POST + `ReadableStream` reader**로 SSE 프레임을
  파싱한다. 파서는 네트워크와 무관한 **순수 함수 유틸**(`src/lib/sse.ts` 등)로 분리해 단위
  테스트한다 (프레임 경계·멀티라인 data·부분 청크 처리).
- 기존 react-query mutation(`useStockAnalysis`/`useArticleAnalysis`) → 스트리밍 훅으로 교체.
  상태: `phase` → 누적 텍스트(delta 합류, 실시간 렌더) → `final`(성공/오류).
- `AIPanel`(주식)·`ArticleAnalysis`(기사) 모두 누적 마크다운을 **실시간 렌더** (2048토큰 규모에서
  react-markdown 재렌더 비용은 무시 가능).
- **마크다운 개선**: `remark-gfm` 추가 (표·취소선·자동링크·체크리스트), 표/코드블록 CSS 보강 —
  색상은 `tokens.css` 변수만 사용 (다크/라이트 모두).

## 4. 테스트

- 백엔드 (기존 FakeBedrock을 델타 시퀀스 제너레이터로 확장):
  - 이벤트 시퀀스: 첫 이벤트 즉시(phase) → delta들 → final(누적 == final의 analysis).
  - 캐시 히트 → final 단독. 팔로워 → waiting 하트비트 후 final.
    (정정 2026-08-04: 캐시 히트는 `phase 1개 + final` — §2 "캐시·동시성 상호작용"의 같은 정정 참고.)
  - 스트림 도중 예외 → final에 오류 문구+status, 연결은 정상 종료.
  - `stop_reason == max_tokens` → `_warn` 기록.
  - 레이트리밋 429는 기존 JSON 유지.
- 프론트: SSE 파서 단위 테스트(경계 조건), 스트리밍 훅/컴포넌트 — 진행 중 렌더·final 반영·오류
  상태 (vitest + testing-library).
- 종단(배포 후): 콜드 기사 분석에서 첫 delta 도착 시간(≪30초)과 최종 완주, 캐시 히트 즉시성.

## 범위 제외 (YAGNI)

- AgentCore/simulateStreaming (불사용 확정 — 실 스트리밍이라 불필요), JSON 이중 모드,
  프롬프트/모델/토큰 상한 변경, 스트림 취소(클라이언트 disconnect 시 Bedrock 중단) 최적화,
  새 인프라. — 필요해지면 별도 결정으로 승격.
