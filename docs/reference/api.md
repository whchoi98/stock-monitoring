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
| Market routes | `backend/app/api/market.py` | `GET /api/market/overview`, `GET /api/market/quotes?market=us\|kr`, news feed; payload builders reused by the scheduler |
| Stock routes | `backend/app/api/stocks.py` | `GET /api/stocks/{symbol}` (+ `/chart?period=`, `/news`, `/orderbook`, `/investors`); price overlay; simulated data flagged |
| AI routes | `backend/app/api/ai.py` | `POST /api/ai/stocks/{symbol}`, `POST /api/ai/articles` — see [agent-llm.md](agent-llm.md) |
| Shared deps | `backend/app/api/deps.py` | `get_state`, `resolve_symbol` (universe gate, 404 outside US 50 + KR 50), cache key builders, `cached()` wrapper (503 + source degraded on failure) |
| Rate limiter | `backend/app/api/ratelimit.py` | `SlidingWindowLimiter` used by the AI routes |
| Models | `backend/app/models.py` | Pydantic response models + the `envelope()` helper |
| App context | `backend/app/state.py` | `AppState`: tiered cache handle + per-source status (`mark_source`) |

### 3. Key Decisions
- **One envelope everywhere**: `{"asOf", "marketOpen", "data"}`. `asOf` is the cached value's timestamp (after a price overlay it becomes the quote's timestamp — the price is the headline datum).
- **Symbols are validated before any cache key exists**: `resolve_symbol` normalizes case and suffixes (`.KS`/`.KQ`) and 404s outside the universe, keeping cache/lock maps finite.
- **Enum-typed query params**: chart `period` is a `Literal` kept identical to the `CHART_TTL` keys (a test asserts the match); FastAPI rejects anything else with 422.
- **Fixed error strings only** (`app_not_ready`, `rate_limited`, `ai_unavailable`, `ai_failed`, `article_unavailable`): exception text may carry an AWS account/ARN/model id and goes to server logs only.
- **Simulated data is always labeled**: `/orderbook` and `/investors` are derived (seeded from the live price / daily candles) and always return `"simulated": true`.
- **No silent failures**: every failure path logs single-line JSON and flips the source status that `/api/health` reports.

### 4. Code Pointers
- `backend/app/models.py` — `envelope()`: the response contract
- `backend/app/api/deps.py` — `resolve_symbol` and `cached()`: the two wrappers almost every route goes through
- `backend/app/api/stocks.py` — `detail_view`: fundamentals + live-price overlay assembly
- `backend/app/api/market.py` — `build_overview`: pure-function assembly of the dashboard payload
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
| 시장 라우트 | `backend/app/api/market.py` | `GET /api/market/overview`, `GET /api/market/quotes?market=us\|kr`, 뉴스 피드. 페이로드 빌더를 스케줄러가 재사용 |
| 종목 라우트 | `backend/app/api/stocks.py` | `GET /api/stocks/{symbol}` (+ `/chart?period=`, `/news`, `/orderbook`, `/investors`). 가격 오버레이, 시뮬레이션 표시 |
| AI 라우트 | `backend/app/api/ai.py` | `POST /api/ai/stocks/{symbol}`, `POST /api/ai/articles` — 상세는 [agent-llm.md](agent-llm.md) |
| 공용 의존성 | `backend/app/api/deps.py` | `get_state`, `resolve_symbol`(유니버스 게이트 — US 50 + KR 50 밖은 404), 캐시 키 빌더, `cached()` 래퍼(실패 시 503 + 소스 degraded) |
| 레이트리미터 | `backend/app/api/ratelimit.py` | AI 라우트가 쓰는 `SlidingWindowLimiter` |
| 모델 | `backend/app/models.py` | pydantic 응답 모델 + `envelope()` 헬퍼 |
| 앱 컨텍스트 | `backend/app/state.py` | `AppState`: 계층 캐시 핸들 + 소스별 상태(`mark_source`) |

### 3. 주요 결정
- **envelope 단일 규약**: `{"asOf", "marketOpen", "data"}`. `asOf`는 캐시된 값의 시각 (가격 오버레이 후에는 시세의 시각 — 가격이 응답의 대표 데이터).
- **캐시 키 생성 전에 심볼 검증**: `resolve_symbol`이 대소문자·접미사(`.KS`/`.KQ`)를 정규화하고 유니버스 밖은 404 — 캐시/락 맵의 유한성 보장.
- **쿼리 파라미터는 enum 타입**: 차트 `period`는 `CHART_TTL` 키와 동일한 `Literal`(테스트가 일치를 검증). 다른 값은 FastAPI가 422로 거절.
- **오류 본문은 고정 문구만** (`app_not_ready`, `rate_limited`, `ai_unavailable`, `ai_failed`, `article_unavailable`): 예외 문자열에는 AWS 계정/ARN/모델 ID가 섞일 수 있어 서버 로그에만 남긴다.
- **시뮬레이션 데이터는 항상 표시**: `/orderbook`·`/investors`는 파생 데이터(현재가 시드 / 일봉 기반)이며 항상 `"simulated": true`를 반환.
- **조용한 실패 금지**: 모든 실패 경로는 단일 라인 JSON 로그 + `/api/health`가 보고하는 소스 상태 반영.

### 4. 코드 포인터
- `backend/app/models.py` — `envelope()`: 응답 계약
- `backend/app/api/deps.py` — `resolve_symbol`, `cached()`: 거의 모든 라우트가 거치는 두 래퍼
- `backend/app/api/stocks.py` — `detail_view`: 펀더멘털 + 실시간 가격 오버레이 조립
- `backend/app/api/market.py` — `build_overview`: 대시보드 페이로드 조립 (순수 함수)
- `backend/app/main.py` — SPA 폴백 규칙(`SPA_METHODS`, `API_PREFIX`)과 lifespan 순서
- `backend/tests/test_api_stocks.py`, `backend/tests/test_api_market.py`, `backend/tests/test_api_ai.py` — 라우트 계약 테스트

### 5. 상호 참조
- 관련 모듈: [data.md](data.md) (라우트가 경유하는 캐시), [agent-llm.md](agent-llm.md) (AI 라우트 상세), [frontend.md](frontend.md) (envelope 소비자), [security.md](security.md) (오류 본문 정책·레이트리밋)
- 관련 ADR: 아직 없음 — 설계 스펙 `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 관련 런북: 아직 없음
