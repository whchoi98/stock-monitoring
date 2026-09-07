# Data / 데이터 구성 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
There is no traditional database: the data layer is a two-tier cache over Yahoo Finance and RSS results — L1 in-memory (per-process) and L2 DynamoDB (`stock-monitoring-cache`, TTL attribute) — orchestrated by `TieredCache` with per-key single-flight locks and an L2 stale fallback. A background scheduler pre-warms the hot keys, and price-like fields are overlaid onto slow fundamentals at request time.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| `MemoryCache` (L1) | `backend/app/cache/memory.py` | In-memory TTL store on monotonic time; write-triggered sweep every 300s bounds the client-derived keys (`ai:article:{sha1(url)[:16]}` and `ai:stock:{symbol}:q:{sha256(question)[:16]}`) |
| `DynamoCache` (L2) | `backend/app/cache/dynamo.py` | Sync boto3 via `asyncio.to_thread`; item schema `pk(S) / data(S, JSON) / ttl(N, epoch) / asOf(S)`; every failure degrades to a cache miss |
| `TieredCache` | `backend/app/cache/tiered.py` | Lookup order L1 → L2 → fetch → L2-stale; per-key lock so concurrent cold callers trigger one upstream fetch; `peek(key, ttl)` is the lock-free L1 → L2 probe the AI routes use before streaming |
| Cache keys | `backend/app/api/deps.py` | Key builders (`quotes:{market}`, `detail:{symbol}`, `chart:{symbol}:{period}`, `news:{symbol}`, `overview`, `news:feed`) + `PREWARMED_KEYS`; the AI keys (`ai:stock:{symbol}`, `ai:stock:{symbol}:q:{hash}`, `ai:article:{hash}`) are built in `backend/app/api/ai.py` |
| TTL table | `backend/app/core/config.py` | `CHART_TTL` (`1w` 10m · `1m` 1h · `3m`/`6m` 6h · `1y`/`5y` 24h), `FUNDAMENTALS_TTL` 12h, `AI_TTL` 6h, `L2_TTL` 24h, refresh intervals 45s/120s/600s |
| Scheduler | `backend/app/core/scheduler.py` | Re-writes pre-warmed keys each cycle (quotes/overview/news, market caps every 10m); *is* the freshness of those keys |
| DynamoDB table | `infra/stacks/stock_monitoring_stack.py` (§2) | `stock-monitoring-cache`, PAY_PER_REQUEST, TTL attribute `ttl`, `RemovalPolicy.DESTROY` (pure cache) |

### 3. Key Decisions
- **Values stored as a JSON string** in the `data` attribute so nested structures and numbers round-trip unchanged (DynamoDB's native numbers would surface as `Decimal`).
- **App-level TTL re-check on `get`**: DynamoDB's own TTL sweep can lag up to 48h. `get_stale` ignores TTL entirely — it is the upstream-failure fallback (`l2-stale` source).
- **Price overlay**: `detail:{symbol}` (12h) is trusted for slow fundamentals only; `price/change/change_pct/volume` are overlaid at request time from `quotes:{market}` (45s refresh) so table, header and order book agree (`stocks.detail_view`).
- **Single-flight per-key locks**: the lock map is bounded by in-flight fetches, not by keys ever seen — this matters because AI keys derive from client-supplied URLs and free-form questions (both hashed; the question is capped at 200 chars and normalised first). The SSE AI routes do not take this lock at all: they `peek` then `put`, and concurrent misses for one key are collapsed by the route's own in-flight registry (`app.state.ai_inflight`).
- **L2 outages never break a request**: every DynamoDB failure is swallowed, logged as single-line JSON, and treated as a miss; the app even boots without L2 (`NullL2` in `main.py`).
- **Symbol universe gate**: cache keys are only built from symbols passing `deps.resolve_symbol` (US 50 + KR 50), keeping key/lock maps finite.

### 4. Code Pointers
- `backend/app/cache/tiered.py` — `TieredCache.get_or_fetch`: the full L1→L2→fetch→stale flow, returns `(value, asOf, source)`
- `backend/app/cache/memory.py` — `SWEEP_INTERVAL_SEC` and the leak rationale in the class comment
- `backend/app/cache/dynamo.py` — `DynamoCache._read`: TTL re-check vs stale read
- `backend/app/api/deps.py` — key builders and `PREWARMED_KEYS` (what `/api/health` reports ages for)
- `backend/app/api/stocks.py` — `live_quote` / `overlay_live_price` / `detail_view`: the price overlay (L1-only read — a detail request must never trigger a 50-symbol fetch)
- `backend/app/core/config.py` — every TTL and refresh-interval constant
- `backend/tests/test_cache_tiered.py`, `backend/tests/test_cache_dynamo.py` — behavioral contracts

### 5. Cross-references
- Related modules: [api.md](api.md) (who reads through the cache), [agent-llm.md](agent-llm.md) (AI result caching), [infrastructure.md](infrastructure.md) (the table resource)
- Related ADRs: none yet — design spec `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- Related runbooks: [quotes-cache-poisoning.md](../runbooks/quotes-cache-poisoning.md) — a fresh-but-empty `quotes:*` entry blanks the stock table; purge the L2 items and, if the task still serves `[]`, replace the task to clear L1

<a id="korean"></a>
## 한국어

### 1. 개요
전통적 데이터베이스는 없다: 데이터 계층은 Yahoo Finance·RSS 결과 위의 2계층 캐시다 — L1 인메모리(프로세스 단위) + L2 DynamoDB(`stock-monitoring-cache`, TTL 속성) — `TieredCache`가 키별 single-flight 락과 L2 stale 폴백으로 오케스트레이션한다. 백그라운드 스케줄러가 핫 키를 선제 갱신하고, 가격 계열 필드는 요청 시점에 느린 펀더멘털 위로 덮어쓴다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| `MemoryCache` (L1) | `backend/app/cache/memory.py` | monotonic 시간 기반 TTL 인메모리 저장소. 쓰기 시 300초마다 sweep — 클라이언트 파생 키(`ai:article:{sha1(url)[:16]}`, `ai:stock:{symbol}:q:{sha256(question)[:16]}`)의 누수 방지 |
| `DynamoCache` (L2) | `backend/app/cache/dynamo.py` | 동기 boto3를 `asyncio.to_thread`로 래핑. 항목 스키마 `pk(S) / data(S, JSON) / ttl(N, epoch) / asOf(S)`. 모든 실패는 캐시 미스로 강등 |
| `TieredCache` | `backend/app/cache/tiered.py` | 조회 순서 L1 → L2 → fetch → L2-stale. 키별 락으로 같은 콜드 키의 동시 호출은 업스트림 조회 1회만. `peek(key, ttl)`은 AI 라우트가 스트리밍 전에 쓰는 락 없는 L1 → L2 프로브 |
| 캐시 키 | `backend/app/api/deps.py` | 키 빌더(`quotes:{market}`, `detail:{symbol}`, `chart:{symbol}:{period}`, `news:{symbol}`, `overview`, `news:feed`) + `PREWARMED_KEYS`. AI 키(`ai:stock:{symbol}`, `ai:stock:{symbol}:q:{hash}`, `ai:article:{hash}`)는 `backend/app/api/ai.py`에서 만든다 |
| TTL 표 | `backend/app/core/config.py` | `CHART_TTL`(`1w` 10분 · `1m` 1시간 · `3m`/`6m` 6시간 · `1y`/`5y` 24시간), `FUNDAMENTALS_TTL` 12h, `AI_TTL` 6h, `L2_TTL` 24h, 갱신 주기 45s/120s/600s |
| 스케줄러 | `backend/app/core/scheduler.py` | 선제 갱신 키를 매 사이클 재기록 (quotes/overview/news, 시총은 10분마다). 이 루프가 곧 해당 키의 신선도 |
| DynamoDB 테이블 | `infra/stacks/stock_monitoring_stack.py` (§2) | `stock-monitoring-cache`, PAY_PER_REQUEST, TTL 속성 `ttl`, `RemovalPolicy.DESTROY` (순수 캐시) |

### 3. 주요 결정
- **값은 `data` 속성에 JSON 문자열로 저장** — 중첩 구조와 숫자 타입이 그대로 왕복한다 (DynamoDB 네이티브 숫자는 `Decimal`로 나온다).
- **`get`에서 앱 레벨 TTL 재확인**: DynamoDB 자체 TTL sweep은 최대 48시간 지연될 수 있다. `get_stale`은 TTL을 완전히 무시 — 업스트림 실패 폴백(`l2-stale` 소스)이다.
- **가격 오버레이**: `detail:{symbol}`(12h)은 느린 펀더멘털만 신뢰. `price/change/change_pct/volume`은 요청 시점에 `quotes:{market}`(45초 갱신)에서 덮어써 테이블·헤더·호가가 같은 가격을 보인다 (`stocks.detail_view`).
- **키별 single-flight 락**: 락 맵은 "본 적 있는 키"가 아니라 진행 중 fetch 수에 비례 — AI 키가 클라이언트 URL과 자유 질의(둘 다 해시, 질문은 200자 상한·정규화 후)에서 파생되므로 중요하다. SSE AI 라우트는 이 락을 타지 않는다: `peek` 후 `put`이며, 같은 키의 동시 미스는 라우트 자체의 진행 중 레지스트리(`app.state.ai_inflight`)가 합친다.
- **L2 장애는 요청을 깨지 않는다**: 모든 DynamoDB 실패는 삼켜지고 단일 라인 JSON으로 기록되며 미스로 취급. L2 없이도 기동한다 (`main.py`의 `NullL2`).
- **심볼 유니버스 게이트**: 캐시 키는 `deps.resolve_symbol`을 통과한 심볼(US 50 + KR 50)로만 생성 — 키/락 맵의 유한성 보장.

### 4. 코드 포인터
- `backend/app/cache/tiered.py` — `TieredCache.get_or_fetch`: L1→L2→fetch→stale 전체 흐름, `(value, asOf, source)` 반환
- `backend/app/cache/memory.py` — `SWEEP_INTERVAL_SEC`와 클래스 주석의 누수 근거
- `backend/app/cache/dynamo.py` — `DynamoCache._read`: TTL 재확인 vs stale 읽기
- `backend/app/api/deps.py` — 키 빌더와 `PREWARMED_KEYS` (`/api/health`가 age를 보고하는 대상)
- `backend/app/api/stocks.py` — `live_quote` / `overlay_live_price` / `detail_view`: 가격 오버레이 (L1만 조회 — 상세 요청이 50종목 조회를 유발하면 안 된다)
- `backend/app/core/config.py` — 모든 TTL·갱신 주기 상수
- `backend/tests/test_cache_tiered.py`, `backend/tests/test_cache_dynamo.py` — 동작 계약 테스트

### 5. 상호 참조
- 관련 모듈: [api.md](api.md) (캐시를 경유하는 호출자), [agent-llm.md](agent-llm.md) (AI 결과 캐싱), [infrastructure.md](infrastructure.md) (테이블 리소스)
- 관련 ADR: 아직 없음 — 설계 스펙 `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 관련 런북: [quotes-cache-poisoning.md](../runbooks/quotes-cache-poisoning.md) — 신선한 빈 `quotes:*` 항목이 종목 테이블을 비우는 장애. L2 항목을 삭제하고, 태스크가 여전히 `[]`를 내면 태스크 교체로 L1을 비운다
