# Frontend / Frontend 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
A React 19 + TypeScript (strict) SPA built with Vite 8, laid out as a **terminal workspace** (ADR-001). Three pages — Dashboard (market workspace), StockDetail (stock workspace with a watchlist rail), ArticleAnalysis — share an app shell: a sticky top block (command bar with brand, nav, ⌘K symbol search and theme toggle; a market strip of index cells and an indicator crawl), the page via `Outlet`, and a sticky bottom status bar (market state, source, polling cadence, as-of, KST clock). All server state flows through TanStack Query hooks that unwrap the backend envelope, the two AI endpoints excepted: they stream SSE and are consumed by `api/aiStream.ts` (§3). Polling uses exactly two constants. In development Vite proxies `/api` to `:8000`; in production the same-origin paths are served by CloudFront.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Entry + routes | `frontend/src/main.tsx` | `RouterProvider` and the route table (routes deliberately not in `App.tsx` — oxlint `react/only-export-components` preserves HMR) |
| App shell | `frontend/src/App.tsx` | Command bar (brand, nav, `SymbolSearch`, `ThemeToggle`) + `MarketStrip` in one sticky block / `Outlet` / `StatusBar`, plus `NotFound` (child `*` route) and `RouteError` (shell `errorElement`) so one dead link never sinks the app |
| HTTP client | `frontend/src/api/client.ts` | Same-origin `/api/...` paths (no base URL); `ApiError { status, detail }`; network failures propagate unwrapped |
| Query hooks | `frontend/src/api/queries.ts` | Envelope unwrapping; every hook returns `{data, asOf, marketOpen, isLoading, error}`; `QUOTE_POLL_MS` 45 000, `NEWS_POLL_MS` 120 000 — GET data only, no AI. `useSymbolUniverse(enabled)` feeds the search from both markets' quotes on the shared `['quotes', market]` keys, gated by `enabled` and without its own polling |
| AI streaming hooks | `frontend/src/api/aiStream.ts` | `useStockAIStream(symbol)` / `useArticleAIStream()`; the two AI endpoints are SSE, so this file (and only this file) calls fetch directly — see §3 |
| API types | `frontend/src/api/types.ts` | `Envelope<T>` and every payload type |
| Pages | `frontend/src/pages/` | `Dashboard.tsx`, `StockDetail.tsx`, `ArticleAnalysis.tsx` |
| Components | `frontend/src/components/` | `common/` (Panel — collapsible by `id`, Stat, MarketStrip, SymbolSearch, StatusBar, MarketStatus, Clock, ScopeTabs, StarButton, NewsList, AlertsWatcher — toasts, ChangeText, ThemeToggle, badges, ErrorCard, Spinner), `market/` (MarketPulse, SectorBars, MacroPanel, StockTable, NewsFeed), `stock/` (Watchlist, StockHeader, AlertForm, PriceChart, CandleTable, OrderBook, InvestorPanel, FundamentalCards, ReturnsRow, StockNews, AIPanel, Week52Bar) |
| Utilities | `frontend/src/lib/` | `format.ts` (number/price formatting), `clock.ts` (HH:MM / KST HH:MM:SS), `search.ts` (`searchSymbols` ranking: exact symbol > symbol prefix > name prefix > substring; KR codes match without `.KS/.KQ`), `markets.ts` (market labels, `QuoteScope` = market or `watch`), `scopedQuotes.ts` (`useScopedQuotes`: one market's quotes or the starred symbols from both), `newsFilter.ts` (`filterNews`: language tab + title keyword), `localStore.ts` + `watchlistStore.ts` / `alertsStore.ts` / `panelStore.ts` (browser-only user state on `useSyncExternalStore`; `evaluateAlerts` is pure), `aiMessages.ts` (AI error → user wording + `phase` labels), `articleLink.ts` (news-link fork: analysis screen vs. source in a new tab), `sse.ts` (incremental SSE frame parser) |
| Chart maths | `frontend/src/components/stock/chartData.ts`, `indicators.ts` | Pure, tested transforms: candles/lines/markers/time keys; `bollingerBands` (20, 2σ, population), `rsi` (14, Wilder), `ema`/`macd` (12, 26, 9) and `summarizeCandle` for the OHLC legend and the candle table |
| Build config | `frontend/vite.config.ts` | Dev proxy `/api → http://localhost:8000`; vitest jsdom + `globals: true` (testing-library auto-cleanup needs a global `afterEach`) |

### 3. Key Decisions
- **No base URL**: paths are always same-origin absolute (`/api/...`) — the Vite proxy covers development, CloudFront covers production; there is nothing to configure per environment.
- **Envelope unwrapping happens only in query hooks** so `asOf`/`marketOpen` are never dropped; the UI shows data freshness via `AsOfBadge`.
- **`marketOpen` is never faked**: while loading or after a failure it is `undefined` — "unknown" and "closed" are different things.
- **Polling only via the two exported constants** (45s quotes / 120s news); hand-rolled `setInterval` is forbidden.
- **UI branches on `ApiError.status`/`detail`** (429 `rate_limited`, 503 `ai_unavailable`, 500 `ai_failed`, 502 `article_unavailable`); `readDetail` never throws even on HTML error bodies from ALB/CloudFront.
- **Deploy build goes into the backend**: `npm run build:deploy` outputs to `backend/static`, which FastAPI serves (`make build` wraps this).
- **Tests colocated** as `.test.tsx`/`.test.ts` next to the code (vitest, 280 tests); lint is oxlint.
- **Symbol search loads nothing until focused**: `SymbolSearch` calls `useSymbolUniverse(focused)`; `⌘K`/`Ctrl+K`/`/` focus it, ↑↓ select, Enter navigates to `/stocks/:symbol`. It is an ARIA 1.2 combobox (input `combobox`, list `listbox`, `aria-activedescendant`).
- **The watchlist rail follows the detail's `market`**, never a guess from the symbol suffix; `StockDetail` mounts it only once the detail has arrived and remounts it (`key={market}`) on a cross-market switch.
- **The chart's overlay toggles flip `visible`**, never recreate a series; the OHLC legend is fed by `subscribeCrosshairMove` through a time→index map and falls back to the last candle off-chart. **RSI/MACD are separate charts** (lightweight-charts v4 is single-pane) linked two ways via `subscribeVisibleLogicalRangeChange` with a re-entrancy guard and an equal `rightPriceScale.minimumWidth` so the x axes coincide; the table view (`CandleTable`) unmounts the canvas entirely. Reference levels (`levels` prop: previous close, 52-week high/low) are price lines; 0 sentinels are skipped.
- **User state lives only in the browser**: the watchlist (★), price alerts and collapsed panels sit in localStorage behind `lib/localStore.ts` (`useSyncExternalStore`, cross-tab `storage` event, junk-tolerant parsers). The backend never sees them; this is not server state and not subject to the react-query rule. The `watch` scope and the alert watcher read the already-shared `['quotes', market]` caches (`useSymbolUniverse`, gated by `enabled`), so they add no request.
- **Alerts fire once**: the shell's `AlertsWatcher` evaluates on every quote poll, records `triggeredAt` before toasting, and only asks for `Notification` permission when the user creates an alert.

#### AI streaming (SSE)
The two AI endpoints answer with `text/event-stream` instead of the envelope, so `frontend/src/api/aiStream.ts` is the **one** file that calls fetch directly — a deliberate, bounded exception to "server state lives in react-query", which caches a single settled result per key and has nowhere to hold a response that grows. Everything else stays in query hooks.

| Event | Payload | Handling in the hook |
|---|---|---|
| `phase` | `{"phase": "fetching" \| "analyzing" \| "waiting"}` | Latest wins (`waiting` heartbeats interleave and `analyzing` can repeat); wording comes from `lib/aiMessages.ts`. `waiting` means *queued* — it covers a follower wait **and** a Bedrock/fetch permit queue, so its label stays neutral about the cause |
| `delta` | `{"text": "…"}` | Appended to `streamText` and rendered as markdown while it grows; the settled `data.analysis` takes over once `final` lands |
| `final` | the envelope, or `{"error", "status"}` | Settles the hook into `data`+`asOf` or an `ApiError`. The backend emits one on **every** path, so its absence is a lost stream: the hook settles such a stream as `stream_incomplete` rather than spinning forever |

- **Failures before the stream starts stay JSON** (429 rate limit with `Retry-After`, 422, 404) and become `ApiError` through `client.ts`'s exported `readDetail` — one detail rule for both paths, HTML 5xx fallback included.
- **`error` is always `ApiError`**: a rejected fetch has no HTTP status, so it is wrapped as status 0 / `network_error`, which keeps the UI free of a second error type.
- **`lib/sse.ts` parses frames incrementally**: a chunk can split a frame, and the body is decoded with `TextDecoder(…, {stream: true})` so a Korean character straddling two chunks is not mangled.
- **A re-run or an unmount discards the in-flight attempt** (abort the fetch, cancel the reader, bump a run counter), so a superseded stream can never write to state.

### 4. Code Pointers
- `frontend/src/main.tsx` — route table, query client, theme bootstrapping
- `frontend/src/api/queries.ts` — `useEnvelopeQuery` / `unwrap`: the shared GET+poll+unwrap path (data routes only; the AI endpoints are not here)
- `frontend/src/api/aiStream.ts` — `useAiStream`: the SSE consume loop, the stale-update guard, and why this file may call fetch
- `frontend/src/lib/sse.ts` — frame parser (chunk boundaries, `\n\n` framing)
- `frontend/src/api/client.ts` — `ApiError` and the `readDetail` fallback rules (shared with the SSE path)
- `frontend/src/lib/articleLink.ts` — `isAnalyzable`: which news links reach `/articles`, and why an empty link is one of them
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
React 19 + TypeScript(strict) SPA, Vite 8 빌드, **터미널 워크스페이스** 레이아웃(ADR-001). 세 페이지 — Dashboard(시장 워크스페이스), StockDetail(워치리스트 레일이 있는 종목 워크스페이스), ArticleAnalysis — 가 앱 셸을 공유한다: 상단 sticky 블록(브랜드·네비·⌘K 종목 검색·테마 토글의 커맨드 바, 지수 셀 + 지표 크롤의 마켓 스트립), `Outlet`의 페이지, 하단 sticky 상태 바(장 상태·출처·폴링 주기·기준 시각·KST 시계). 서버 상태는 전부 envelope을 언래핑하는 TanStack Query 훅을 거친다 — 단 두 AI 엔드포인트는 예외로, SSE로 흘러오며 `api/aiStream.ts`가 소비한다(§3). 폴링은 상수 두 개만 쓴다. 개발에서는 Vite가 `/api`를 `:8000`으로 프록시하고, 운영에서는 같은 오리진 경로를 CloudFront가 서빙한다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 엔트리 + 라우트 | `frontend/src/main.tsx` | `RouterProvider`와 라우트 테이블 (의도적으로 `App.tsx`에 두지 않음 — oxlint `react/only-export-components`가 HMR 보존) |
| 앱 셸 | `frontend/src/App.tsx` | 커맨드 바(브랜드·네비·`SymbolSearch`·`ThemeToggle`) + `MarketStrip`을 한 sticky 블록에 / `Outlet` / `StatusBar` + `NotFound`(`*` 자식 라우트)·`RouteError`(셸 `errorElement`) — 죽은 링크 하나가 앱 전체를 내려앉히지 않는다 |
| HTTP 클라이언트 | `frontend/src/api/client.ts` | 같은 오리진 `/api/...` 경로(base URL 없음). `ApiError { status, detail }`. 네트워크 실패는 감싸지 않고 전파 |
| 쿼리 훅 | `frontend/src/api/queries.ts` | envelope 언래핑. 모든 훅이 `{data, asOf, marketOpen, isLoading, error}` 반환. `QUOTE_POLL_MS` 45 000, `NEWS_POLL_MS` 120 000 — GET 데이터 전용(AI 없음). `useSymbolUniverse(enabled)`는 두 시장 시세를 공유 키 `['quotes', market]`로 검색에 공급하며 `enabled` 게이트·자체 폴링 없음 |
| AI 스트리밍 훅 | `frontend/src/api/aiStream.ts` | `useStockAIStream(symbol)` / `useArticleAIStream()`. 두 AI 엔드포인트가 SSE라 이 파일만 fetch를 직접 쓴다 — §3 참조 |
| API 타입 | `frontend/src/api/types.ts` | `Envelope<T>`와 모든 페이로드 타입 |
| 페이지 | `frontend/src/pages/` | `Dashboard.tsx`, `StockDetail.tsx`, `ArticleAnalysis.tsx` |
| 컴포넌트 | `frontend/src/components/` | `common/`(Panel — `id`로 접기, Stat, MarketStrip, SymbolSearch, StatusBar, MarketStatus, Clock, ScopeTabs, StarButton, NewsList, AlertsWatcher — 토스트, ChangeText, ThemeToggle, 배지, ErrorCard, Spinner), `market/`(MarketPulse, SectorBars, MacroPanel, StockTable, NewsFeed), `stock/`(Watchlist, StockHeader, AlertForm, PriceChart, CandleTable, OrderBook, InvestorPanel, FundamentalCards, ReturnsRow, StockNews, AIPanel, Week52Bar) |
| 유틸리티 | `frontend/src/lib/` | `format.ts`(숫자/가격 포맷), `clock.ts`(HH:MM / KST HH:MM:SS), `search.ts`(`searchSymbols` 순위: 심볼 정확 > 심볼 접두 > 종목명 접두 > 포함. KR 코드는 `.KS/.KQ` 없이도 매칭), `markets.ts`(시장 라벨, `QuoteScope` = 시장 또는 `watch`), `scopedQuotes.ts`(`useScopedQuotes`: 한 시장 시세 또는 두 시장의 ★ 종목), `newsFilter.ts`(`filterNews`: 언어 탭 + 제목 키워드), `localStore.ts` + `watchlistStore.ts` / `alertsStore.ts` / `panelStore.ts`(`useSyncExternalStore` 위의 브라우저 전용 사용자 상태. `evaluateAlerts`는 순수), `aiMessages.ts`(AI 오류 → 사용자 문구 + `phase` 라벨), `articleLink.ts`(뉴스 링크 분기 — 분석 화면 vs 원문 새 탭), `sse.ts`(SSE 프레임 파서) |
| 차트 계산 | `frontend/src/components/stock/chartData.ts`, `indicators.ts` | 순수·테스트된 변환: 캔들/라인/마커/시각 키. `bollingerBands`(20, 2σ, 모집단), `rsi`(14, Wilder), `ema`/`macd`(12, 26, 9), OHLC 레전드·데이터 표용 `summarizeCandle` |
| 빌드 설정 | `frontend/vite.config.ts` | dev 프록시 `/api → http://localhost:8000`. vitest jsdom + `globals: true` (testing-library 자동 cleanup은 전역 `afterEach` 필요) |

### 3. 주요 결정
- **base URL 없음**: 경로는 항상 같은 오리진 절대 경로(`/api/...`) — 개발은 Vite 프록시, 운영은 CloudFront. 환경별 설정이 필요 없다.
- **envelope 언래핑은 쿼리 훅에서만** — `asOf`/`marketOpen`을 잃지 않는다. 데이터 신선도는 `AsOfBadge`로 노출.
- **`marketOpen`을 꾸미지 않는다**: 첫 로딩 중·실패 후에는 `undefined` — "모름"과 "장 닫힘"은 다르다.
- **폴링은 export된 상수 두 개만** (시세 45초 / 뉴스 120초). 수동 `setInterval` 금지.
- **화면은 `ApiError.status`/`detail`로 분기** (429 `rate_limited`, 503 `ai_unavailable`, 500 `ai_failed`, 502 `article_unavailable`). `readDetail`은 ALB/CloudFront의 HTML 오류 본문에서도 절대 throw하지 않는다.
- **배포 빌드는 백엔드로**: `npm run build:deploy`가 `backend/static`에 출력, FastAPI가 서빙 (`make build`가 래핑).
- **테스트는 colocated** `.test.tsx`/`.test.ts` (vitest, 280개). 린트는 oxlint.
- **종목 검색은 포커스 전까지 아무것도 요청하지 않는다**: `SymbolSearch`가 `useSymbolUniverse(focused)`를 부른다. `⌘K`/`Ctrl+K`/`/`로 포커스, ↑↓ 선택, Enter로 `/stocks/:symbol` 이동. ARIA 1.2 콤보박스(입력 `combobox`, 목록 `listbox`, `aria-activedescendant`).
- **워치리스트 레일은 상세의 `market`을 따른다** — 심볼 접미사로 추측하지 않는다. `StockDetail`은 상세가 도착한 뒤에만 레일을 마운트하고, 시장이 바뀌는 전환에는 `key={market}`으로 다시 마운트한다.
- **차트 오버레이 토글은 `visible`만 바꾼다** — 시리즈를 다시 만들지 않는다. OHLC 레전드는 `subscribeCrosshairMove`가 시각→인덱스 맵을 거쳐 채우고, 차트 밖에서는 마지막 캔들로 되돌아간다. **RSI/MACD는 별도 차트**다(lightweight-charts v4는 단일 패널) — `subscribeVisibleLogicalRangeChange`로 양방향 동기화(재진입 가드)하고 `rightPriceScale.minimumWidth`를 같게 두어 x축을 맞춘다. 표 뷰(`CandleTable`)는 캔버스를 통째로 언마운트한다. 기준선(`levels` 프롭: 전일종가·52주 고/저)은 가격선이며 0 센티널은 건너뛴다.
- **사용자 상태는 브라우저에만 산다**: 관심 종목(★)·가격 알림·패널 접힘은 `lib/localStore.ts`(`useSyncExternalStore`, 다른 탭은 `storage` 이벤트, 손상 허용 파서) 위의 localStorage에 있다. 백엔드는 이 값을 모른다 — 서버 상태가 아니므로 react-query 규칙의 대상이 아니다. `watch` 스코프와 알림 감시는 이미 공유되는 `['quotes', market]` 캐시(`useSymbolUniverse`, `enabled` 게이트)를 읽어 요청을 늘리지 않는다.
- **알림은 한 번만 울린다**: 셸의 `AlertsWatcher`가 시세 폴링마다 판정하고, 토스트 전에 `triggeredAt`을 기록하며, `Notification` 권한은 사용자가 알림을 만들 때만 묻는다.

#### AI 스트리밍 (SSE)
두 AI 엔드포인트는 envelope 대신 `text/event-stream`으로 답한다. 그래서 `frontend/src/api/aiStream.ts`가 fetch를 직접 쓰는 **유일한** 파일이다 — "서버 상태는 react-query로만"의 의도적이고 좁은 예외다(react-query는 키마다 완결된 결과 하나를 캐시하므로 자라나는 응답을 담을 자리가 없다). 그 밖의 서버 상태는 전부 쿼리 훅에 남는다.

| 이벤트 | 페이로드 | 훅의 처리 |
|---|---|---|
| `phase` | `{"phase": "fetching" \| "analyzing" \| "waiting"}` | 최신 값이 이긴다(`waiting` 하트비트가 섞이고 `analyzing`이 두 번 올 수 있다). 문구는 `lib/aiMessages.ts`. `waiting`은 **줄 서 있다**는 뜻으로 팔로워 대기와 Bedrock/fetch permit 대기를 모두 덮으므로 라벨은 원인에 중립이다 |
| `delta` | `{"text": "…"}` | `streamText`에 이어 붙이고 자라는 동안 마크다운으로 렌더. `final` 도착 후에는 완결된 `data.analysis`가 우선한다 |
| `final` | envelope 또는 `{"error", "status"}` | 훅을 `data`+`asOf` 또는 `ApiError`로 마감한다. 백엔드가 **모든** 경로에서 하나를 내므로 없이 끝난 스트림은 유실이며, 훅은 그것을 `stream_incomplete` 오류로 마감한다(스피너가 영원히 돌지 않는다) |

- **스트림 시작 전 실패는 그대로 JSON이다**(429 + `Retry-After`, 422, 404). `client.ts`가 export한 `readDetail`을 거쳐 `ApiError`가 된다 — ALB/CloudFront의 HTML 5xx 폴백까지 두 경로가 같은 규칙을 쓴다.
- **`error`는 언제나 `ApiError`**: reject된 fetch에는 HTTP 상태가 없으므로 status 0 / `network_error`로 감싼다 — 화면에 두 번째 오류 타입이 생기지 않는다.
- **`lib/sse.ts`는 프레임을 점진적으로 파싱한다**: 청크가 프레임을 가를 수 있고, 본문은 `TextDecoder(…, {stream: true})`로 디코딩해 청크 경계에 걸친 한글이 깨지지 않게 한다.
- **재실행·언마운트는 진행 중 시도를 폐기한다**(fetch abort + reader cancel + 실행 번호 증가) — 밀려난 스트림이 상태를 쓰는 경로가 없다.

### 4. 코드 포인터
- `frontend/src/main.tsx` — 라우트 테이블, 쿼리 클라이언트, 테마 부트스트랩
- `frontend/src/api/queries.ts` — `useEnvelopeQuery` / `unwrap`: 공통 GET+폴링+언래핑 경로 (데이터 라우트 전용 — AI 엔드포인트는 여기 없다)
- `frontend/src/api/aiStream.ts` — `useAiStream`: SSE 소비 루프, 낡은 갱신 차단 장치, 이 파일이 fetch를 직접 쓰는 근거
- `frontend/src/lib/sse.ts` — 프레임 파서 (청크 경계, `\n\n` 프레이밍)
- `frontend/src/api/client.ts` — `ApiError`와 `readDetail` 폴백 규칙 (SSE 경로와 공유)
- `frontend/src/lib/articleLink.ts` — `isAnalyzable`: 어떤 뉴스 링크가 `/articles`로 가는지, 빈 링크가 왜 그중 하나인지
- `frontend/src/App.tsx` — 셸 레이아웃, `NotFound`/`RouteError` 근거 (스펙 7: 전체 붕괴 방지)
- `frontend/src/components/stock/chartData.ts` — lightweight-charts용 캔들/MA 변환
- `frontend/vite.config.ts` — 프록시 + vitest `globals` 근거

### 5. 상호 참조
- 관련 모듈: [api.md](api.md) (소비하는 envelope 계약), [ui.md](ui.md) (컴포넌트가 써야 하는 토큰/테마), [agent-llm.md](agent-llm.md) (AI 패널 동작)
- 관련 ADR: 아직 없음 — 설계 스펙 `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 관련 런북: 아직 없음
