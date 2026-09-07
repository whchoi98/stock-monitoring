# Frontend Module (React 19 + TypeScript + Vite)

## 역할 / Role
주식 모니터링 SPA — 터미널 워크스페이스 레이아웃(ADR-001). Dashboard(시장) / StockDetail(종목, 워치리스트 레일) / ArticleAnalysis 3개 페이지 (react-router-dom v6).
Stock monitoring SPA laid out as a terminal workspace (ADR-001), served by the FastAPI backend in production.

## 구조 / Key Files
- `src/api/` — `client.ts`(fetch 래퍼), `queries.ts`(**서버 데이터는 @tanstack/react-query 훅으로만**; `useSymbolUniverse(enabled)`는 검색용 두 시장 시세, 키 공유·enabled 게이트), `aiStream.ts`+`lib/sse.ts`(**유일한 예외**: 두 AI 엔드포인트는 SSE `phase`→`delta`*→`final`이라 fetch 직접 사용), `types.ts`(백엔드 `app/models.py` 응답 형태와 일치 유지).
- `src/components/common/` — `Panel`(모든 위젯의 껍데기: eyebrow·제목·액션·`flush`·`id`로 접기), `Stat`, `MarketStrip`(지수 셀 + 지표 크롤), `SymbolSearch`(⌘K 콤보박스), `StatusBar`/`MarketStatus`/`Clock`, `ScopeTabs`(미국/한국/★관심), `StarButton`, `AlertsWatcher`(가격 알림 판정 + 토스트), `NewsList`(뉴스 행 공용), `ChangeText`, `ThemeToggle`, 배지, `ErrorCard`, `Spinner`.
- `src/components/market/` — `MarketPulse`, `SectorBars`, `MacroPanel`, `StockTable`(QUOTE MONITOR, 스코프·★), `NewsFeed`(언어 탭·키워드 필터). `src/components/stock/` — `Watchlist`, `StockHeader`(★·`AlertForm`), `PriceChart`(1W~5Y, MA/BOLL/LVL + VOL·RSI·MACD 동기 보조 패널 — 거래량은 메인 오버레이가 아님, 캔들/표 뷰), `CandleTable`, `OrderBook`, `InvestorPanel`, `FundamentalCards`, `ReturnsRow`, `StockNews`, `AIPanel`(질문 입력·프리셋 → `analyze({question})`), `Week52Bar`.
- `src/components/stock/chartData.ts`, `indicators.ts` — 차트 순수 함수 (변환 / 볼린저·RSI·EMA·MACD·캔들 요약). 직접 단위 테스트 대상.
- `src/pages/`, `src/lib/`(`format`, `clock`, `search`(종목 검색 순위 — 심볼·영문·한글 `name_ko`·초성), `hangul`(초성 분해), `markets`(`QuoteScope`), `scopedQuotes`, `newsFilter`, `localStore` + `watchlistStore`/`alertsStore`/`panelStore`(브라우저 전용 사용자 상태), `aiMessages`, `articleLink`, `sse`), `src/styles/`(`tokens.css` 디자인 토큰, `global.css`).

## 명령 / Commands
```bash
cd frontend
npm run dev            # dev 서버 (백엔드는 make run으로 :8000)
npx vitest run         # 테스트 308개 (colocated *.test.tsx / *.test.ts)
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

## 주의 / Gotchas
- `build:deploy`는 `../backend/static`을 **비우고** 다시 쓴다 — 백엔드 static에 수동 파일을 두지 말 것.
- `src/api/types.ts` 변경 시 백엔드 모델과의 정합을 먼저 확인한다 (계약 소스는 백엔드).
- `tokens.css`의 `--term-top-h`(85px)는 실측값 — 커맨드 바/스트립 높이가 바뀌면 다시 측정해 갱신한다(sticky 레일·뉴스 열의 높이 상한이 이 값에 달려 있다).
- 주석은 한국어+영어 병기 관례 유지 / Keep comments bilingual ko+en per project convention.
