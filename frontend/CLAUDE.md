# Frontend Module (React 19 + TypeScript + Vite)

## 역할 / Role
주식 모니터링 SPA — 터미널 워크스페이스 레이아웃(ADR-001). Dashboard(시장) / StockDetail(종목, 워치리스트 레일) / ArticleAnalysis 3개 페이지 (react-router-dom 7.18.3).
Stock monitoring SPA laid out as a terminal workspace (ADR-001), served by the FastAPI backend in production.

## 구조 / Key Files
- `src/api/` — `client.ts`(fetch 래퍼), `queries.ts`(**서버 데이터는 @tanstack/react-query 훅으로만**; `useSymbolUniverse(enabled)`는 검색용 두 시장 시세, 키 공유·enabled 게이트), `aiStream.ts`+`lib/sse.ts`(**유일한 예외**: 두 AI 엔드포인트는 SSE `phase`→`delta`*→`final`이라 fetch 직접 사용), `types.ts`(백엔드 `app/models.py` 응답 형태와 일치 유지).
- `src/components/common/` — `Panel`(모든 위젯의 껍데기: eyebrow·제목·액션·`flush`·`id`로 접기), `Stat`, `MarketStrip`(지수 셀 + 지표 크롤), `SymbolSearch`(⌘K 콤보박스), `StatusBar`/`MarketStatus`/`Clock`, `ScopeTabs`(미국/한국/★관심), `StarButton`, `AlertsWatcher`(가격 알림 판정 + 토스트), `UpdateToast`(서비스 워커 새 버전·오프라인 준비 토스트, `virtual:pwa-register/react`), `NewsList`(뉴스 행 공용), `ChangeText`, `ThemeToggle`, 배지, `ErrorCard`, `Spinner`.
- `src/components/market/` — `MarketPulse`, `SectorBars`, `MacroPanel`, `StockTable`(QUOTE MONITOR, 스코프·★), `NewsFeed`(언어 탭·키워드 필터). `src/components/stock/` — `Watchlist`, `StockHeader`(★·`AlertForm`), `PriceChart`(1W~5Y, MA/BOLL/LVL + VOL·RSI·MACD 동기 보조 패널 — 거래량은 메인 오버레이가 아님, 캔들/표 뷰), `CandleTable`, `OrderBook`, `InvestorPanel`, `FundamentalCards`, `ReturnsRow`, `StockNews`, `AIPanel`(질문 입력·프리셋 → `analyze({question})`), `Week52Bar`.
- `src/components/stock/chartData.ts`, `indicators.ts` — 차트 순수 함수 (변환 / 볼린저·RSI·EMA·MACD·캔들 요약). 직접 단위 테스트 대상.
- `src/pages/`, `src/lib/`(`format`, `clock`, `search`(종목 검색 순위 — 심볼·영문·한글 `name_ko`·초성), `hangul`(초성 분해), `markets`(`QuoteScope`), `scopedQuotes`, `newsFilter`, `localStore` + `watchlistStore`/`alertsStore`/`panelStore`(브라우저 전용 사용자 상태), `online`(`useOnline` — 상태 바 오프라인 배지), `stickyOffsets`(고정 블록 실측 높이 → `--sticky-top-h/--sticky-bottom-h`, 토스트 앵커), `aiMessages`, `articleLink`, `sse`), `src/styles/`(`tokens.css` 디자인 토큰, `global.css`), `public/icons/`(PWA 아이콘), `src/vite-env.d.ts`(`vite-plugin-pwa/react` 타입).

## 명령 / Commands
```bash
cd frontend
npm run dev            # dev 서버 (백엔드는 make run으로 :8000)
npx vitest run         # 테스트 452개 (colocated *.test.tsx / *.test.ts)
npm run test:e2e       # production build + 15 Chromium scenarios; fixtures, no AWS/Yahoo calls
npx oxlint             # 린트
npx tsc -b             # 타입 체크 (build:deploy는 tsc를 생략한다)
npm run build:deploy   # vite build --outDir ../backend/static (emptyOutDir — 배포 산출물)
```

## 규칙 / Rules
- **TypeScript strict** + 함수형 컴포넌트만. 서버 상태는 react-query, 수동 fetch/useEffect 데이터 로딩 금지 (AI 스트리밍 `api/aiStream.ts`만 예외 — 그 파일 밖으로 넓히지 말 것).
- **위젯은 `Panel`로 감싼다** — eyebrow는 대문자 영문(예: `PRICE ACTION`), 제목은 한국어. 표·목록은 `flush`.
- **차트는 lightweight-charts** (v4). 데이터 변환·지표 계산은 `chartData.ts`/`indicators.ts` 같은 순수 함수로 분리해 테스트한다. `attributionLogo`는 끄지 않는다(라이선스).
- **테스트는 colocated**: 소스 옆에 `Foo.test.tsx` (vitest + @testing-library/react + jsdom).
- **테마 / Theme**: `<html data-theme="dark|light">`로만 전환 (다크 기본). 색상은 반드시 `styles/tokens.css`의 CSS 변수 사용 — 하드코딩 금지. canvas(`PriceChart.readStyles`)만 토큰 값을 읽어 넘긴다.
- **한국 관례 색상**: 상승 = 빨강(`--up`), 하락 = 파랑(`--down`). 서구권 관례(green/red)로 바꾸지 않는다. 액센트는 앰버(`--accent`), `--ok`(초록)는 상태 점 전용.
- **숫자·심볼·시각은 고정폭**(`--font-mono`, JetBrains Mono latin 서브셋), 본문은 Pretendard. AI 응답 렌더링은 react-markdown + `remark-gfm`(표) — 스타일은 `global.css`의 `.markdown`.
- **컴포넌트 파일은 컴포넌트만 export** (oxlint `react/only-export-components`) — 상수는 `lib/`로 (예: `lib/markets.ts`).
- **사용자 상태는 localStorage 스토어로만** (`lib/localStore.ts` → `createLocalStore` + `useLocalStore`): 읽기 실패는 fallback, 쓰기 실패는 세션 메모리. 서버 상태가 아니므로 react-query에 넣지 않는다. 관심·알림은 공유 키 `['quotes', market]`(`useSymbolUniverse(enabled)`)만 읽는다 — 새 폴링을 만들지 말 것.
- **`attributionLogo`는 보조 패널(RSI/MACD)에서도 끄지 않는다** — 라이선스 가드 테스트가 소스를 검사한다.
- **PWA 서비스 워커는 앱 셸만 담당한다 (ADR-002)** — `vite.config.ts`의 `VitePWA`가 빌드 산출물을 프리캐시하고 SPA 경로를 `index.html`로 돌린다(`/api/` 제외). **`/api/*`에 워커 라우트를 추가하지 말 것** — 백엔드 신선도 규칙과 비용 방어 바깥의 두 번째 캐시가 된다. 업데이트는 `prompt` 방식(`UpdateToast`) — `autoUpdate`로 바꾸지 않는다(AI 스트리밍 중 자동 리로드 금지).

## 품질 개선 계약 / Quality contracts
- `Dashboard`의 `?market=us|kr&watch=1`은 시장/관심 선택을 보존한다. 검색·섹터·등락·정렬은 스코프 전환 시 초기화하고 밀도만 `quotePreferences`에 저장한다. / URL-backed scope; filters reset by scope, density persists.
- `quoteFilter.ts`는 결측값을 정렬 방향과 무관하게 마지막에 둔다. `quoteCsv.ts`는 화면 순서·원본 숫자·통화를 보존하고 텍스트 수식 해석을 방어한다. / Null-last sorting and safe displayed-order CSV.
- `DataNotice`는 **실제로 남아 있는 데이터가 있을 때만** 사용한다. 사용 가능한 데이터 없는 실패는 `ErrorCard`, 다른 시장의 응답 대기는 로딩으로 구분한다. / Distinguish retained data, initial errors, pending markets and empty results.
- `useScopedQuotes('watch')`는 미국·한국 공유 시세 키를 모두 폴링한다. `useSymbolUniverse` 자체에는 폴링을 추가하지 않는다. / Both-market watch polling, passive search.
- `apiGet(path, signal?)`은 본문 읽기를 포함해 30초 제한을 두고 Query의 취소 신호를 전달한다. `isFetching`은 기존 데이터 갱신 중에도 true다. / Bounded cancellable GETs; initial loading differs from refetching.
- `MarketPulse`는 시세 표와 같은 시세로 보합 포함 집계를 한다. 전체 시장 통계로 표시하지 않는다. / Breadth covers the tracked universe only.
- `AlertsWatcher`는 대기 알림이 있을 때 양 시장 `useQuotes`를 명시적으로 켠다. 수동 검색 유니버스만 읽으면 기사 화면에서 감시가 멈춘다. / Active, gated quote polling keeps alerts working on every route.
- `ArticleStart`는 명시적 제출 전 AI를 호출하지 않는다. SSRF 검증은 서버 책임이며 입력 폼은 대체 보안 경계가 아니다. / Explicit submission; client validation does not replace SSRF guards.
- 기준 시각·뉴스 시각·하단 시계는 KST. 펀더멘털/기간수익률은 가격 오버레이 시각 대신 `last_updated`를 우선한다. / Consistent KST and honest fundamentals timestamps.
- 모바일에서 기본 시세 열을 줄이더라도 “전체 열”로 모든 데이터·정렬에 접근할 수 있어야 한다. / Preserve full-column access on phones.
- 브라우저 테스트는 `playwright.config.ts`의 전용 포트를 사용하며 다른 실행 중 서버를 재사용하지 않는다. / Never reuse another project's preview server.

## 주의 / Gotchas
- `build:deploy`는 `../backend/static`을 **비우고** 다시 쓴다 — 백엔드 static에 수동 파일을 두지 말 것.
- `src/api/types.ts` 변경 시 백엔드 모델과의 정합을 먼저 확인한다 (계약 소스는 백엔드).
- `tokens.css`의 `--term-top-h`(109px)는 실측값 — 커맨드 바/스트립 높이가 바뀌면 다시 측정해 갱신한다(sticky 레일·뉴스 열의 높이 상한이 이 값에 달려 있다).
- 주석은 한국어+영어 병기 관례 유지 / Keep comments bilingual ko+en per project convention.
