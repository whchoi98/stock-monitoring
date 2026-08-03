# Frontend / Frontend 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
A React 19 + TypeScript (strict) SPA built with Vite 8. Three pages — Dashboard, StockDetail, ArticleAnalysis — share an app shell (top nav / `Outlet` / bottom ticker). All server state flows through TanStack Query hooks that unwrap the backend envelope; polling uses exactly two constants. In development Vite proxies `/api` to `:8000`; in production the same-origin paths are served by CloudFront.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Entry + routes | `frontend/src/main.tsx` | `RouterProvider` and the route table (routes deliberately not in `App.tsx` — oxlint `react/only-export-components` preserves HMR) |
| App shell | `frontend/src/App.tsx` | Nav / `Outlet` / `TickerBar`, plus `NotFound` (child `*` route) and `RouteError` (shell `errorElement`) so one dead link never sinks the app |
| HTTP client | `frontend/src/api/client.ts` | Same-origin `/api/...` paths (no base URL); `ApiError { status, detail }`; network failures propagate unwrapped |
| Query hooks | `frontend/src/api/queries.ts` | Envelope unwrapping; every hook returns `{data, asOf, marketOpen, isLoading, error}`; `QUOTE_POLL_MS` 45 000, `NEWS_POLL_MS` 120 000 |
| API types | `frontend/src/api/types.ts` | `Envelope<T>` and every payload type |
| Pages | `frontend/src/pages/` | `Dashboard.tsx`, `StockDetail.tsx`, `ArticleAnalysis.tsx` |
| Components | `frontend/src/components/` | `common/` (Card, ChangeText, TickerBar, ThemeToggle, badges), `market/` (StockTable, IndexCards, NewsFeed, SectorBars), `stock/` (PriceChart, OrderBook, AIPanel, FundamentalCards, …) |
| Utilities | `frontend/src/lib/` | `format.ts` (number/price formatting), `aiMessages.ts` (AI error-detail → user wording) |
| Build config | `frontend/vite.config.ts` | Dev proxy `/api → http://localhost:8000`; vitest jsdom + `globals: true` (testing-library auto-cleanup needs a global `afterEach`) |

### 3. Key Decisions
- **No base URL**: paths are always same-origin absolute (`/api/...`) — the Vite proxy covers development, CloudFront covers production; there is nothing to configure per environment.
- **Envelope unwrapping happens only in query hooks** so `asOf`/`marketOpen` are never dropped; the UI shows data freshness via `AsOfBadge`.
- **`marketOpen` is never faked**: while loading or after a failure it is `undefined` — "unknown" and "closed" are different things.
- **Polling only via the two exported constants** (45s quotes / 120s news); hand-rolled `setInterval` is forbidden.
- **UI branches on `ApiError.status`/`detail`** (429 `rate_limited`, 503 `ai_unavailable`, 500 `ai_failed`, 502 `article_unavailable`); `readDetail` never throws even on HTML error bodies from ALB/CloudFront.
- **Deploy build goes into the backend**: `npm run build:deploy` outputs to `backend/static`, which FastAPI serves (`make build` wraps this).
- **Tests colocated** as `.test.tsx`/`.test.ts` next to the code (vitest, 110 tests); lint is oxlint.

### 4. Code Pointers
- `frontend/src/main.tsx` — route table, query client, theme bootstrapping
- `frontend/src/api/queries.ts` — `useEnvelopeQuery` / `unwrap`: the shared GET+poll+unwrap path; AI hooks add `analyze` (mutation)
- `frontend/src/api/client.ts` — `ApiError` and `readDetail` fallback rules
- `frontend/src/App.tsx` — shell layout; `NotFound`/`RouteError` rationale (spec 7: no total collapse)
- `frontend/src/components/stock/chartData.ts` — candle/MA transforms for lightweight-charts
- `frontend/vite.config.ts` — proxy + vitest `globals` rationale

### 5. Cross-references
- Related modules: [api.md](api.md) (the envelope contract this consumes), [ui.md](ui.md) (tokens/theme the components must use), [agent-llm.md](agent-llm.md) (AI panel behavior)
- Related ADRs: none yet — design spec `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- Related runbooks: none yet

<a id="korean"></a>
## 한국어

### 1. 개요
React 19 + TypeScript(strict) SPA, Vite 8 빌드. 세 페이지 — Dashboard, StockDetail, ArticleAnalysis — 가 앱 셸(상단 네비 / `Outlet` / 하단 티커)을 공유한다. 서버 상태는 전부 envelope을 언래핑하는 TanStack Query 훅을 거치고, 폴링은 상수 두 개만 쓴다. 개발에서는 Vite가 `/api`를 `:8000`으로 프록시하고, 운영에서는 같은 오리진 경로를 CloudFront가 서빙한다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 엔트리 + 라우트 | `frontend/src/main.tsx` | `RouterProvider`와 라우트 테이블 (의도적으로 `App.tsx`에 두지 않음 — oxlint `react/only-export-components`가 HMR 보존) |
| 앱 셸 | `frontend/src/App.tsx` | 네비 / `Outlet` / `TickerBar` + `NotFound`(`*` 자식 라우트)·`RouteError`(셸 `errorElement`) — 죽은 링크 하나가 앱 전체를 내려앉히지 않는다 |
| HTTP 클라이언트 | `frontend/src/api/client.ts` | 같은 오리진 `/api/...` 경로(base URL 없음). `ApiError { status, detail }`. 네트워크 실패는 감싸지 않고 전파 |
| 쿼리 훅 | `frontend/src/api/queries.ts` | envelope 언래핑. 모든 훅이 `{data, asOf, marketOpen, isLoading, error}` 반환. `QUOTE_POLL_MS` 45 000, `NEWS_POLL_MS` 120 000 |
| API 타입 | `frontend/src/api/types.ts` | `Envelope<T>`와 모든 페이로드 타입 |
| 페이지 | `frontend/src/pages/` | `Dashboard.tsx`, `StockDetail.tsx`, `ArticleAnalysis.tsx` |
| 컴포넌트 | `frontend/src/components/` | `common/`(Card, ChangeText, TickerBar, ThemeToggle, 배지), `market/`(StockTable, IndexCards, NewsFeed, SectorBars), `stock/`(PriceChart, OrderBook, AIPanel, FundamentalCards 등) |
| 유틸리티 | `frontend/src/lib/` | `format.ts`(숫자/가격 포맷), `aiMessages.ts`(AI 오류 detail → 사용자 문구) |
| 빌드 설정 | `frontend/vite.config.ts` | dev 프록시 `/api → http://localhost:8000`. vitest jsdom + `globals: true` (testing-library 자동 cleanup은 전역 `afterEach` 필요) |

### 3. 주요 결정
- **base URL 없음**: 경로는 항상 같은 오리진 절대 경로(`/api/...`) — 개발은 Vite 프록시, 운영은 CloudFront. 환경별 설정이 필요 없다.
- **envelope 언래핑은 쿼리 훅에서만** — `asOf`/`marketOpen`을 잃지 않는다. 데이터 신선도는 `AsOfBadge`로 노출.
- **`marketOpen`을 꾸미지 않는다**: 첫 로딩 중·실패 후에는 `undefined` — "모름"과 "장 닫힘"은 다르다.
- **폴링은 export된 상수 두 개만** (시세 45초 / 뉴스 120초). 수동 `setInterval` 금지.
- **화면은 `ApiError.status`/`detail`로 분기** (429 `rate_limited`, 503 `ai_unavailable`, 500 `ai_failed`, 502 `article_unavailable`). `readDetail`은 ALB/CloudFront의 HTML 오류 본문에서도 절대 throw하지 않는다.
- **배포 빌드는 백엔드로**: `npm run build:deploy`가 `backend/static`에 출력, FastAPI가 서빙 (`make build`가 래핑).
- **테스트는 colocated** `.test.tsx`/`.test.ts` (vitest, 110개). 린트는 oxlint.

### 4. 코드 포인터
- `frontend/src/main.tsx` — 라우트 테이블, 쿼리 클라이언트, 테마 부트스트랩
- `frontend/src/api/queries.ts` — `useEnvelopeQuery` / `unwrap`: 공통 GET+폴링+언래핑 경로. AI 훅은 `analyze`(mutation) 추가
- `frontend/src/api/client.ts` — `ApiError`와 `readDetail` 폴백 규칙
- `frontend/src/App.tsx` — 셸 레이아웃, `NotFound`/`RouteError` 근거 (스펙 7: 전체 붕괴 방지)
- `frontend/src/components/stock/chartData.ts` — lightweight-charts용 캔들/MA 변환
- `frontend/vite.config.ts` — 프록시 + vitest `globals` 근거

### 5. 상호 참조
- 관련 모듈: [api.md](api.md) (소비하는 envelope 계약), [ui.md](ui.md) (컴포넌트가 써야 하는 토큰/테마), [agent-llm.md](agent-llm.md) (AI 패널 동작)
- 관련 ADR: 아직 없음 — 설계 스펙 `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 관련 런북: 아직 없음
