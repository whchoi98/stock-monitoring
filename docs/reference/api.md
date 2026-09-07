# API / API 구성 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
The FastAPI layer serves everything under `/api/*` and falls back to the SPA (`index.html`) for non-API GET/HEAD paths. Every data response shares one envelope — `{"asOf", "marketOpen", "data"}` — and every synchronous service call (yfinance, boto3) is wrapped in `asyncio.to_thread` so the event loop never blocks.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| App factory | `backend/app/main.py` | Router registration, lifespan (swap `NullL2`→`DynamoCache`, start scheduler), SPA static serving (`/api` 404s are never rewritten to `index.html`) |
| Health route | `backend/app/api/health.py` | `GET /api/health` — liveness only, always 200, no external calls; reports per-source status (yahoo/rss/bedrock) + pre-warmed cache ages |
| Market routes | `backend/app/api/market.py` | `GET /api/market/overview`, `GET /api/market/quotes?market=us\|kr`, news feed; payload builders reused by the scheduler. `overview_payload` returns a `Partial` whenever a piece falls short (`coverage_shortfall`: full coverage for quotes, a 60% floor for the additive indices/indicators), so the outer `cached()` cannot re-mark yahoo `ok` over a short table |
| Stock routes | `backend/app/api/stocks.py` | `GET /api/stocks/{symbol}` (+ `/chart?period=`, `/news`, `/orderbook`, `/investors`); price overlay; simulated data flagged |
| AI routes | `backend/app/api/ai.py` | `POST /api/ai/stocks/{symbol}` (optional JSON body `{"question": "…"}`, 1–200 chars after normalisation; 422 otherwise), `POST /api/ai/articles` — the only `text/event-stream` responses (`phase` → `delta`* → `final`; §3), cost defense in [agent-llm.md](agent-llm.md) |
| Shared deps | `backend/app/api/deps.py` | `get_state`, `resolve_symbol` (universe gate, 404 outside US 50 + KR 50), cache key builders, `cached()` wrapper (503 + source degraded on failure; a fetcher returning `Partial` is cached and served but still degrades the source) |
| Rate limiter | `backend/app/api/ratelimit.py` | `SlidingWindowLimiter` used by the AI routes |
| Models | `backend/app/models.py` | Pydantic response models + the `envelope()` helper |
| App context | `backend/app/state.py` | `AppState`: tiered cache handle + per-source status (`mark_source`) |

### 3. Key Decisions
- **One envelope everywhere**: `{"asOf", "marketOpen", "data"}`. `asOf` is the cached value's timestamp (after a price overlay it becomes the quote's timestamp — the price is the headline datum).
- **Symbols are validated before any cache key exists**: `resolve_symbol` normalizes case and suffixes (`.KS`/`.KQ`) and 404s outside the universe, keeping cache/lock maps finite.
- **Enum-typed query params**: chart `period` is a `Literal` (`1w 1m 3m 6m 1y 5y`; `1w` is hourly bars, `5y` weekly, the rest daily) kept identical to the `CHART_TTL` keys (a test asserts the match); FastAPI rejects anything else with 422.
- **Fixed error strings only** (`app_not_ready`, `rate_limited`, `ai_unavailable`, `ai_failed`, `article_unavailable`): exception text may carry an AWS account/ARN/model id and goes to server logs only.
- **Simulated data is always labeled**: `/orderbook` and `/investors` are derived (seeded from the live price / daily candles) and always return `"simulated": true`.
- **No silent failures**: every failure path logs single-line JSON and flips the source status that `/api/health` reports.

#### The AI routes are streams, not envelopes
- **`text/event-stream`, `phase` → `delta`* → `final`**: both AI routes stream. The first `phase` leaves immediately and every delta resets the CloudFront/ALB idle counters, which is what removed the wall-clock ceiling a long analysis used to hit. A `final` is emitted on **every** path, so a client that never sees one knows the stream was lost.
- **After the stream opens the HTTP status is already 200**, so failures travel *inside* `final` as `{"error", "status"}` — that is where the 503 `ai_unavailable` / 500 `ai_failed` / 502 `article_unavailable` split is carried. Only decisions made *before* the first byte keep real status codes: 429 (`rate_limited` + `Retry-After`), 422 validation, 404 unknown symbol — all still plain JSON. Successful `final` payloads carry the same envelope as every other route, so the contract is unchanged, only its delivery.
- **No wait is silent**: one heartbeat loop (`_waiting_heartbeats`) serves all three waits — a follower waiting on its leader, a leader queued for a Bedrock permit, and an article request queued for a fetch permit — emitting `phase: waiting` every `HEARTBEAT_SECONDS` (5 s). `analyzing`/`fetching` is (re-)announced only *after* the permit is in hand, so a queued stream never claims to be working.
- **An in-flight registry collapses duplicates**: concurrent requests for the same cache key share one Bedrock stream — the leader streams and caches, followers inherit its outcome. If the leader disappears mid-stream, followers settle with an `ai_failed` final instead of waiting forever. The Bedrock permit is held for the whole stream and returned in a `finally`, so a consumer that walks away (ASGI disconnect → the task is cancelled) releases it and never caches a half-finished analysis.
- **The bridge to boto3**: `converse_stream` is synchronous, so a dedicated pump thread reads its event stream into an `asyncio.Queue` that the route drains — the event loop is never blocked (the same rule as every other service call).

### 4. Code Pointers
- `backend/app/models.py` — `envelope()`: the response contract
- `backend/app/api/deps.py` — `resolve_symbol` and `cached()`: the two wrappers almost every route goes through
- `backend/app/api/stocks.py` — `detail_view`: fundamentals + live-price overlay assembly
- `backend/app/api/market.py` — `build_overview`: pure-function assembly of the dashboard payload
- `backend/app/api/ai.py` — `_sse` (frame format), `_analysis_stream` (the SSE skeleton and the leader/follower registry), `_waiting_heartbeats` / `_permit_wait` (the one heartbeat loop every wait uses)
- `backend/app/main.py` — SPA fallback rules (`SPA_METHODS`, `API_PREFIX`) and the lifespan sequence
- `backend/tests/test_api_stocks.py`, `backend/tests/test_api_market.py`, `backend/tests/test_api_ai.py` — route contracts

### 5. Cross-references
- Related modules: [data.md](data.md) (cache the routes read through), [agent-llm.md](agent-llm.md) (AI routes in depth), [frontend.md](frontend.md) (envelope consumer), [security.md](security.md) (error-body policy, rate limiting)
- Related ADRs: none yet — design spec `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- Related runbooks: none yet

<a id="korean"></a>
## 한국어

### 1. 개요
FastAPI 계층은 `/api/*` 전체를 서빙하고, API가 아닌 GET/HEAD 경로는 SPA(`index.html`)로 폴백한다. 모든 데이터 응답은 단일 envelope — `{"asOf", "marketOpen", "data"}` — 을 공유하며, 동기 서비스 호출(yfinance, boto3)은 전부 `asyncio.to_thread`로 감싸 이벤트 루프를 막지 않는다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 앱 팩토리 | `backend/app/main.py` | 라우터 등록, lifespan(`NullL2`→`DynamoCache` 교체, 스케줄러 기동), SPA 정적 서빙 (`/api` 404는 절대 `index.html`로 바꾸지 않음) |
| 헬스 라우트 | `backend/app/api/health.py` | `GET /api/health` — 생존 판정 전용, 항상 200, 외부 호출 없음. 소스별 상태(yahoo/rss/bedrock) + 선제 갱신 캐시 age 보고 |
| 시장 라우트 | `backend/app/api/market.py` | `GET /api/market/overview`, `GET /api/market/quotes?market=us\|kr`, 뉴스 피드. 페이로드 빌더를 스케줄러가 재사용. 조각 중 하나라도 결손이면 `overview_payload`가 `Partial`을 반환한다(`coverage_shortfall` — 시세는 전량, 추가 행인 지수·지표는 60% 하한) → 바깥쪽 `cached()`가 짧은 테이블 위에 yahoo `ok`를 덮어쓰지 못한다 |
| 종목 라우트 | `backend/app/api/stocks.py` | `GET /api/stocks/{symbol}` (+ `/chart?period=`, `/news`, `/orderbook`, `/investors`). 가격 오버레이, 시뮬레이션 표시 |
| AI 라우트 | `backend/app/api/ai.py` | `POST /api/ai/stocks/{symbol}`(선택 JSON 본문 `{"question": "…"}`, 정규화 후 1~200자, 아니면 422), `POST /api/ai/articles` — 유일한 `text/event-stream` 응답(`phase` → `delta`* → `final`, §3). 비용 방어 상세는 [agent-llm.md](agent-llm.md) |
| 공용 의존성 | `backend/app/api/deps.py` | `get_state`, `resolve_symbol`(유니버스 게이트 — US 50 + KR 50 밖은 404), 캐시 키 빌더, `cached()` 래퍼(실패 시 503 + 소스 degraded. fetcher가 `Partial`을 반환하면 값은 캐시·서빙하되 소스는 degraded) |
| 레이트리미터 | `backend/app/api/ratelimit.py` | AI 라우트가 쓰는 `SlidingWindowLimiter` |
| 모델 | `backend/app/models.py` | pydantic 응답 모델 + `envelope()` 헬퍼 |
| 앱 컨텍스트 | `backend/app/state.py` | `AppState`: 계층 캐시 핸들 + 소스별 상태(`mark_source`) |

### 3. 주요 결정
- **envelope 단일 규약**: `{"asOf", "marketOpen", "data"}`. `asOf`는 캐시된 값의 시각 (가격 오버레이 후에는 시세의 시각 — 가격이 응답의 대표 데이터).
- **캐시 키 생성 전에 심볼 검증**: `resolve_symbol`이 대소문자·접미사(`.KS`/`.KQ`)를 정규화하고 유니버스 밖은 404 — 캐시/락 맵의 유한성 보장.
- **쿼리 파라미터는 enum 타입**: 차트 `period`는 `CHART_TTL` 키와 동일한 `Literal`(`1w 1m 3m 6m 1y 5y` — `1w`는 시간봉, `5y`는 주봉, 나머지는 일봉. 테스트가 일치를 검증). 다른 값은 FastAPI가 422로 거절.
- **오류 본문은 고정 문구만** (`app_not_ready`, `rate_limited`, `ai_unavailable`, `ai_failed`, `article_unavailable`): 예외 문자열에는 AWS 계정/ARN/모델 ID가 섞일 수 있어 서버 로그에만 남긴다.
- **시뮬레이션 데이터는 항상 표시**: `/orderbook`·`/investors`는 파생 데이터(현재가 시드 / 일봉 기반)이며 항상 `"simulated": true`를 반환.
- **조용한 실패 금지**: 모든 실패 경로는 단일 라인 JSON 로그 + `/api/health`가 보고하는 소스 상태 반영.

#### AI 라우트는 envelope이 아니라 스트림이다
- **`text/event-stream`, `phase` → `delta`* → `final`**: 두 AI 라우트는 스트리밍이다. 첫 `phase`가 즉시 나가고 델타마다 CloudFront/ALB idle 카운터가 리셋되므로, 긴 분석이 걸리던 wall-clock 제약이 사라졌다. `final`은 **모든** 경로에서 emit되므로 그것을 못 본 클라이언트는 스트림이 유실됐다고 판단할 수 있다.
- **스트림이 열린 뒤에는 HTTP 상태가 이미 200**이라 그 이후의 실패는 `final` **안에** `{"error", "status"}`로 실린다 — 503 `ai_unavailable` / 500 `ai_failed` / 502 `article_unavailable` 구분이 거기서 전달된다. 첫 바이트 **전에** 결정되는 것만 실제 상태 코드를 유지한다: 429(`rate_limited` + `Retry-After`), 422 검증, 404 미지원 심볼 — 모두 그대로 평범한 JSON이다. 성공 `final`의 페이로드는 다른 라우트와 같은 envelope이므로 계약이 아니라 전달 방식만 바뀌었다.
- **조용한 대기 없음**: 하트비트 루프 하나(`_waiting_heartbeats`)가 세 가지 대기를 모두 담당한다 — 팔로워의 선점자 대기, 선점자의 Bedrock permit 대기, 기사 요청의 fetch permit 대기 — `HEARTBEAT_SECONDS`(5초)마다 `phase: waiting`을 낸다. `analyzing`/`fetching`은 permit을 **확보한 뒤에** (다시) 알리므로 줄 서 있는 스트림이 작업 중이라고 말하지 않는다.
- **진행 중 레지스트리가 중복을 합친다**: 같은 캐시 키의 동시 요청은 Bedrock 스트림 하나를 공유한다 — 선점자가 스트리밍·캐싱하고 팔로워가 결과를 승계한다. 선점자가 스트림 도중 사라지면 팔로워는 영원히 기다리지 않고 `ai_failed` final로 마감된다. Bedrock permit은 스트림 완료까지 보유하고 `finally`에서 반납하므로, 소비자가 떠난 경우(ASGI disconnect → 태스크 취소)에도 permit이 풀리고 절반짜리 분석은 캐시되지 않는다.
- **boto3와의 브리지**: `converse_stream`은 동기 API라 전용 펌프 스레드가 이벤트 스트림을 읽어 `asyncio.Queue`에 넣고 라우트가 그것을 비운다 — 이벤트 루프를 막지 않는다(다른 모든 서비스 호출과 같은 규칙).

### 4. 코드 포인터
- `backend/app/models.py` — `envelope()`: 응답 계약
- `backend/app/api/deps.py` — `resolve_symbol`, `cached()`: 거의 모든 라우트가 거치는 두 래퍼
- `backend/app/api/stocks.py` — `detail_view`: 펀더멘털 + 실시간 가격 오버레이 조립
- `backend/app/api/market.py` — `build_overview`: 대시보드 페이로드 조립 (순수 함수)
- `backend/app/api/ai.py` — `_sse`(프레임 형식), `_analysis_stream`(SSE 골격 + 선점자/팔로워 레지스트리), `_waiting_heartbeats` / `_permit_wait`(모든 대기가 쓰는 단일 하트비트 루프)
- `backend/app/main.py` — SPA 폴백 규칙(`SPA_METHODS`, `API_PREFIX`)과 lifespan 순서
- `backend/tests/test_api_stocks.py`, `backend/tests/test_api_market.py`, `backend/tests/test_api_ai.py` — 라우트 계약 테스트

### 5. 상호 참조
- 관련 모듈: [data.md](data.md) (라우트가 경유하는 캐시), [agent-llm.md](agent-llm.md) (AI 라우트 상세), [frontend.md](frontend.md) (envelope 소비자), [security.md](security.md) (오류 본문 정책·레이트리밋)
- 관련 ADR: 아직 없음 — 설계 스펙 `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 관련 런북: 아직 없음
