# Agent · LLM / Agent · LLM 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
The LLM layer produces Korean-markdown stock analyses and article summaries/translations via a Claude model on Amazon Bedrock (`global.anthropic.claude-sonnet-4-6`, `ap-northeast-2`). It is the only part of the system that costs money per call, so every request passes a fixed defense order: per-IP rate limit → result cache → global concurrency cap → Bedrock.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Bedrock service | `backend/app/services/bedrock_ai.py` | `converse_stream` wrapper (`stream_invoke`, yielding text deltas), prompts ported from the TUI, typed errors (`BedrockUnavailableError`/`BedrockCallError`), success-only availability cache |
| AI routes | `backend/app/api/ai.py` | `POST /api/ai/stocks/{symbol}` (no body) and `POST /api/ai/articles` (`{url, title, language}`); enforces the defense order and the fixed error bodies |
| Rate limiter | `backend/app/api/ratelimit.py` | Sliding window, 3 req/min/IP (`AI_RATE_PER_MIN`), keyed per [security.md](security.md) |
| Model config | `backend/app/core/config.py` | `BEDROCK_MODEL_ID`, `BEDROCK_REGION`, `AI_TTL` 6h, `AI_RATE_PER_MIN` 3, `AI_GLOBAL_CONCURRENCY` 2 |
| Article fetch | `backend/app/services/news.py` | `fetch_article_content` — the guarded fetch that feeds the article prompt |
| Frontend consumers | `frontend/src/api/aiStream.ts`, `frontend/src/components/stock/AIPanel.tsx`, `frontend/src/pages/ArticleAnalysis.tsx`, `frontend/src/lib/aiMessages.ts` | `useStockAIStream` / `useArticleAIStream` consume the SSE stream (phase wording, deltas rendered as they arrive, the `final` settling the result); error → user wording |

### 3. Key Decisions
- **Model id `global.anthropic.claude-sonnet-4-6` lives in code, not the task env**: `ap-northeast-2` has no `us.`-prefixed sonnet-4-6 inference profile (verified 2026-08-02 against `list-inference-profiles`; the `global.` profile was confirmed with a live call). The infra deliberately does not inject `BEDROCK_MODEL_ID`.
- **Defense order is fixed**: (1) rate limit — *before* the cache, so even cache hits spend budget and one IP cannot poll without bound; (2) result cache (`AI_TTL` 6h); (3) Bedrock inside the global semaphore (2 concurrent), the permit held until the stream ends. The route's in-flight registry additionally collapses concurrent identical requests into one Bedrock stream: one leader streams and caches, the others heartbeat `phase: waiting` and inherit its outcome.
- **Cache keys**: `ai:stock:{symbol}` and `ai:article:{sha1(url)[:16]}` — the article key is URL-only (same URL + different title returns the first analysis; the raw URL never enters the key).
- **Typed errors map to distinct statuses** (carried in the SSE `final` event as `{"error", "status"}`, since the HTTP status is already committed once the stream starts): 503 `ai_unavailable` (credentials/access codes: `AccessDeniedException` etc.), 500 `ai_failed` (other call failures), 502 `article_unavailable` (empty article body — no Bedrock call, and **failures are never cached**).
- **Prompt inputs come from existing caches**: stock analysis reuses the price-overlaid detail and cached news titles, so an AI request rarely hits yfinance/RSS. Caps: article body 6 000 chars (`ARTICLE_CONTENT_LIMIT`), 5 news titles, response tokens 4 096 (article) / 1 024 (stock).
- **Availability cache remembers success only**, so a transient credential failure recovers on the next call. The semaphore is created inside the running loop (asyncio primitives bind their creation loop) and is held for the whole stream; the synchronous boto3 event stream is read by a dedicated pump thread that feeds an `asyncio.Queue`.

### 4. Code Pointers
- `backend/app/api/ai.py` — module docstring: the whole defense order; `_analysis_stream` (the SSE skeleton: immediate first phase, cache probe, leader/follower, `final` on every path, and why the 503/500/502 split is mapped there rather than via `deps.cached`); `_bedrock_deltas` (semaphore held for the whole stream + source-status marking)
- `backend/app/services/bedrock_ai.py` — `_UNAVAILABLE_ERROR_CODES` (the 503 set), `_stock_prompt` / `_article_prompt` prompts, token caps, `stream_invoke` (the thread-to-queue bridge)
- `backend/app/core/config.py` — the model-id comment explaining the `global.` prefix requirement
- `backend/app/api/ai.py` — `key_stock_ai` / `key_article_ai` cache-key builders
- `frontend/src/lib/aiMessages.ts` — how each error detail is worded for users
- `backend/tests/test_bedrock_ai.py`, `backend/tests/test_api_ai.py` — error mapping and defense-order contracts

### 5. Cross-references
- Related modules: [security.md](security.md) (rate-limit key, SSRF guard on article URLs), [data.md](data.md) (result caching, single-flight), [api.md](api.md) (envelope, error policy), [iac.md](iac.md) (Bedrock IAM, region)
- Related ADRs: none yet — design spec `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- Related runbooks: none yet

<a id="korean"></a>
## 한국어

### 1. 개요
LLM 계층은 Amazon Bedrock의 Claude 모델(`global.anthropic.claude-sonnet-4-6`, `ap-northeast-2`)로 한국어 마크다운 종목 분석과 기사 요약·번역을 생성한다. 시스템에서 호출당 비용이 드는 유일한 부분이므로 모든 요청이 고정된 방어 순서를 거친다: IP별 레이트리밋 → 결과 캐시 → 전역 동시 실행 제한 → Bedrock.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| Bedrock 서비스 | `backend/app/services/bedrock_ai.py` | `converse_stream` 래퍼(`stream_invoke`, 텍스트 델타 yield), TUI에서 포팅한 프롬프트, 타입 있는 예외(`BedrockUnavailableError`/`BedrockCallError`), 성공만 기억하는 가용성 캐시 |
| AI 라우트 | `backend/app/api/ai.py` | `POST /api/ai/stocks/{symbol}`(본문 없음), `POST /api/ai/articles`(`{url, title, language}`). 방어 순서와 고정 오류 본문 강제 |
| 레이트리미터 | `backend/app/api/ratelimit.py` | 슬라이딩 윈도우, 3회/분/IP(`AI_RATE_PER_MIN`). 키 선택은 [security.md](security.md) 참조 |
| 모델 설정 | `backend/app/core/config.py` | `BEDROCK_MODEL_ID`, `BEDROCK_REGION`, `AI_TTL` 6h, `AI_RATE_PER_MIN` 3, `AI_GLOBAL_CONCURRENCY` 2 |
| 기사 조회 | `backend/app/services/news.py` | `fetch_article_content` — 기사 프롬프트에 공급되는 가드된 조회 |
| 프론트 소비자 | `frontend/src/api/aiStream.ts`, `frontend/src/components/stock/AIPanel.tsx`, `frontend/src/pages/ArticleAnalysis.tsx`, `frontend/src/lib/aiMessages.ts` | `useStockAIStream` / `useArticleAIStream`이 SSE를 소비한다(단계 문구, 도착하는 대로 렌더되는 델타, `final`로 결과 확정). 오류 → 사용자 문구 |

### 3. 주요 결정
- **모델 ID `global.anthropic.claude-sonnet-4-6`는 태스크 env가 아니라 코드에**: `ap-northeast-2`에는 `us.` 프리픽스 sonnet-4-6 추론 프로파일이 없다 (2026-08-02 `list-inference-profiles` 실측; `global.` 프로파일은 실호출로 확인). 인프라는 의도적으로 `BEDROCK_MODEL_ID`를 주입하지 않는다.
- **방어 순서는 고정**: ① 레이트리밋 — 캐시보다 **앞**이라 캐시 히트도 예산을 소비, 한 IP가 무한 폴링 불가. ② 결과 캐시(`AI_TTL` 6h). ③ 전역 세마포어(동시 2) 안에서 Bedrock 호출, permit은 스트림 완료까지 보유. 라우트의 진행 중 스트림 레지스트리가 추가로 동일 키 동시 요청을 Bedrock 1회로 합친다 — 선점자가 스트리밍·캐싱하고 나머지는 `phase: waiting` 하트비트 후 그 결과를 승계한다.
- **캐시 키**: `ai:stock:{symbol}`, `ai:article:{sha1(url)[:16]}` — 기사 키는 URL만 사용 (같은 URL + 다른 제목이면 먼저 생성된 분석 반환; 원본 URL은 키에 들어가지 않음).
- **타입 있는 예외가 상태 코드로 구분 매핑** (스트림이 시작된 뒤에는 HTTP 상태를 바꿀 수 없으므로 SSE `final` 이벤트의 `{"error", "status"}`로 전달): 503 `ai_unavailable`(자격 증명/접근 계열: `AccessDeniedException` 등), 500 `ai_failed`(그 외 호출 실패), 502 `article_unavailable`(본문 없음 — Bedrock 미호출, **실패는 절대 캐시하지 않음**).
- **프롬프트 입력은 기존 캐시에서**: 종목 분석은 가격 오버레이된 상세와 캐시된 뉴스 제목을 재사용 — AI 요청이 yfinance/RSS를 새로 때리는 일은 드물다. 상한: 기사 본문 6,000자(`ARTICLE_CONTENT_LIMIT`), 뉴스 제목 5개, 응답 토큰 4,096(기사) / 1,024(종목).
- **가용성 캐시는 성공만 기억** — 일시적 자격 증명 실패는 다음 호출에서 복구. 세마포어는 실행 중인 루프 안에서 생성(asyncio 프리미티브는 생성 시점 루프에 묶임)되고 스트림 완료까지 보유. 동기 boto3 이벤트 스트림은 전용 펌프 스레드가 읽어 `asyncio.Queue`로 넘긴다.

### 4. 코드 포인터
- `backend/app/api/ai.py` — 모듈 docstring: 방어 순서 전체. `_analysis_stream`(SSE 골격: 첫 phase 즉시·캐시 프로브·선점자/팔로워·모든 경로에서 final, 503/500/502 구분을 `deps.cached` 대신 여기서 매핑하는 이유), `_bedrock_deltas`(스트림 완료까지 세마포어 보유 + 소스 상태 반영)
- `backend/app/services/bedrock_ai.py` — `_UNAVAILABLE_ERROR_CODES`(503 대상 집합), `_stock_prompt` / `_article_prompt` 프롬프트, 토큰 상한, `stream_invoke`(스레드→큐 브리지)
- `backend/app/core/config.py` — `global.` 프리픽스가 필요한 이유를 설명하는 모델 ID 주석
- `backend/app/api/ai.py` — `key_stock_ai` / `key_article_ai` 캐시 키 빌더
- `frontend/src/lib/aiMessages.ts` — 오류 detail별 사용자 문구
- `backend/tests/test_bedrock_ai.py`, `backend/tests/test_api_ai.py` — 오류 매핑·방어 순서 계약 테스트

### 5. 상호 참조
- 관련 모듈: [security.md](security.md) (레이트리밋 키, 기사 URL의 SSRF 가드), [data.md](data.md) (결과 캐싱·single-flight), [api.md](api.md) (envelope·오류 정책), [iac.md](iac.md) (Bedrock IAM·리전)
- 관련 ADR: 아직 없음 — 설계 스펙 `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 관련 런북: 아직 없음
