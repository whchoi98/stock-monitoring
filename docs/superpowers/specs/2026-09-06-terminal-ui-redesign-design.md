# 터미널 UI 개편 설계 / Terminal UI Redesign (Design Spec)

- 작성 / Written: 2026-09-06
- 상태 / Status: 승인(자율 실행 — `/goal` 지시로 사용자 승인 대기 없이 결정 기록) / Approved (autonomous run under `/goal`; decisions recorded in lieu of a live approval)
- 참조 / Reference: `img/IMG_6046.JPG`(Seoul Terminal 스타일 한국어 터미널), `img/IMG_6047.JPG`(Bloomberg Terminal)
- 이전 스펙 / Supersedes §6 of: `2026-08-01-stock-monitoring-design.md`

---

## 1. 목표 / Goal

Toss Invest 참조의 카드형 대시보드를 **상용 증권 터미널 수준의 밀도 있는 워크스페이스**로 개편한다.
두 참조 이미지가 공유하는 디자인 언어를 채택한다:

| 요소 | 참조 이미지에서 관찰된 것 | 이 프로젝트의 적용 |
|---|---|---|
| 상단 커맨드 바 | 로고 · 메뉴 · 종목 검색(⌘K) · 우측 액션 | 브랜드 · 네비 · **종목 검색 콤보박스** · 테마 토글 |
| 마켓 스트립 | 지수/자산 셀이 가로로 늘어선 고정 띠 | 지수 5개 고정 셀 + 경제지표 11개 크롤 |
| 패널 그리드 | 얇은 1px 테두리, 4–6px 라운드, 대문자 소형 헤더, 3열 | `Panel`(eyebrow + 제목 + 액션) + 페이지별 CSS grid |
| 워치리스트 레일 | 좌측 좁은 종목 목록, 선택 행 강조 | 종목 상세의 좌측 레일(같은 시장 50종목, 현재 종목 강조) |
| 프라이스 액션 | 큰 현재가, 기간 탭, 지표 토글(MA/BOLL/…), 캔들+거래량 | 기간 탭 + **MA5/MA20/BOLL/VOL 토글** + **OHLC 크로스헤어 레전드** |
| 뉴스 와이어 | 시각 · 출처 태그 · 제목 행 | `NewsList` 공용 컴포넌트 |
| AI 리서치 | 우측 하단 패널, 실행 버튼, 상태 표시 | 기존 SSE 스트리밍 패널을 터미널 스킨으로 |
| 하단 상태 바 | 데이터 출처 · 시각 · 세션 | 출처 · 폴링 주기 · 시뮬레이션 안내 · 장 상태 · asOf · KST 시계 |
| 숫자 서체 | 고정폭/타뷸러 숫자 | JetBrains Mono(숫자·심볼) + Pretendard(본문) |

**바꾸지 않는 것 / Invariants kept**
- 상승=빨강(`--up`) / 하락=파랑(`--down`) / 보합=본문색 — 참조 이미지의 서구식 초록/빨강은 **채택하지 않는다** (CLAUDE.md 정확성 규칙).
- 색상은 `tokens.css` 변수만. 테마는 `<html data-theme>`로만 전환. 다크 기본.
- 서버 상태는 react-query 훅(`api/queries.ts`)만, 폴링은 `QUOTE_POLL_MS`/`NEWS_POLL_MS`만. AI는 `api/aiStream.ts`(SSE) 유일 예외 유지.
- 시뮬레이션 데이터(호가·수급)는 `SimulatedBadge` 의무.
- 라우트 3개(`/`, `/stocks/:symbol`, `/articles`)와 라우트 테이블 위치(`main.tsx`), lazy 로딩, `NotFound`/`RouteError`.
- lightweight-charts `attributionLogo` 기본값 유지(라이선스).
- 오류 문구 표(`lib/aiMessages.ts`), `ApiError` 분기, 위젯 단위 `ErrorCard` + 재시도.
- 백엔드 API는 변경하지 않는다 (차트 기간은 1W/1M/3M/1Y 그대로).

## 2. 범위 밖 / Out of scope

- 주문·포트폴리오·옵션 플로우·시나리오 분석 등 데이터 소스가 없는 패널은 **만들지 않는다** (가짜 빈 패널 금지).
- RSI/MACD 서브 패널 — lightweight-charts v4는 단일 패널이라 별도 차트 동기화가 필요. 이번 범위 밖.
- 차트 기간 6M/5Y 추가(백엔드 변경 필요) — 후속.
- 모바일 전용 UX 재설계 — 반응형 스택만 보장(390px에서 가로 스크롤 없음).

## 3. 정보 구조 / Information architecture

라우트는 그대로, 각 화면이 **워크스페이스 그리드**가 된다.

### 3.1 앱 셸 (`App.tsx`)

```
.terminal
├ .term-top (sticky)
│  ├ TopBar      브랜드 | 네비(시장 · 기사 분석) | SymbolSearch(⌘K, /) | ThemeToggle
│  └ MarketStrip 지수 5셀(고정) | 경제지표 크롤(aria-hidden 사본 1벌) | asOf 칩
├ main.term-main  <Outlet/>
└ StatusBar (sticky bottom)  ● 장중/장마감/확인 중 · DATA Yahoo Finance · 시세 45s · 뉴스 120s · 호가·수급 시뮬레이션 | 기준 HH:MM:SS · HH:MM:SS KST
```

- `MarketStrip`은 `TickerBar`를 대체한다. 지수는 항상 보이는 고정 셀(참조 이미지의 "INDICES" 띠), 지표는 크롤. 데이터가 없으면(로딩/실패) 띠 전체를 렌더하지 않는다(기존 계약 유지).
- `StatusBar`의 장 상태는 envelope `marketOpen`(KR 또는 US 개장)에서 오며, **undefined면 "확인 중"** — 모름과 장마감을 구분한다(기존 규칙).
- `Clock`은 1초 UI 클럭(데이터 폴링이 아니므로 setInterval 금지 규칙의 대상이 아님 — `AsOfBadge`와 같은 근거).

### 3.2 시장 워크스페이스 `/` (`Dashboard.tsx`)

```
≥1200px: grid-template-columns: 1fr 1fr 340px
┌──────────────────────┬─────────────────┬────────────────┐
│ MARKET PULSE         │ SECTOR HEAT     │ NEWS WIRE      │
│ 등락 종목수 + breadth│ 섹터 평균 등락  │ (2행 span,     │
│ + 상승/하락/거래량 상위│ 막대            │  내부 스크롤)  │
├──────────────────────┴─────────────────┤                │
│ QUOTE MONITOR  [미국|한국]  정렬 가능 밀집 표 (행 → 상세) │                │
└────────────────────────────────────────┴────────────────┘
900–1199px: 2열(뉴스가 아래로) · <900px: 1열 스택
```

- 시장 탭(US/KR)은 페이지 상태로 유지하고 세 패널(펄스·섹터·표)에 함께 전달한다.
- 지수 카드(`IndexCards`)는 삭제한다 — 지수는 모든 화면의 `MarketStrip`이 보여준다.
- `MarketSummary` → `MarketPulse`로 개명·재구성(내용 동일: breadth + 상위 3종 리스트 3개).

### 3.3 종목 워크스페이스 `/stocks/:symbol` (`StockDetail.tsx`)

```
≥1280px: grid-template-columns: 240px minmax(0,1fr) 320px
┌──────────┬──────────────────────────────────────┬──────────────┐
│ WATCHLIST│ QUOTE HEADER 심볼·종목명·현재가·등락  │ ORDER BOOK   │
│ 같은 시장│ 시가/고가/저가/전일/거래량 · 1일/52주 게이지│ (시뮬레이션) │
│ 50종목   ├──────────────────────────────────────┼──────────────┤
│ 현재 종목│ PRICE ACTION 기간 탭 · MA5/MA20/BOLL/VOL│ INVESTOR FLOW│
│ 강조     │ OHLC 레전드 · 캔들+거래량 차트         │ (시뮬레이션) │
│ 클릭 →   ├──────────────────────────────────────┼──────────────┤
│ 종목 전환│ STATS 핵심지표 6 + 기간수익률 4       │ AI RESEARCH  │
│          ├──────────────────────────────────────┤ (스트리밍)   │
│          │ NEWS WIRE (종목)                      │              │
└──────────┴──────────────────────────────────────┴──────────────┘
900–1279px: 레일 숨김, 2열 · <900px: 1열 스택
```

- `Watchlist`는 종목 상세의 `market`이 도착한 뒤 렌더한다(심볼 접미사로 시장을 추측하지 않는다 — 기존 규칙). 레일 안의 US/KR 토글로 다른 시장 종목으로도 이동 가능.
- `AIPanel`은 `key={symbol}` 리마운트 계약 유지.
- `StockHeader`는 페이지 `<h1>`이며, 기존 필드(open/high/low/prev_close/volume)를 추가로 노출한다.

### 3.4 기사 분석 `/articles` (`ArticleAnalysis.tsx`)

읽기 화면. 로직·문구·자동 실행(정확히 1회) 계약은 그대로, 껍데기만 `Panel`(AI RESEARCH · 기사 분석)로 바꾼다. 최대 폭 860px 유지.

## 4. 컴포넌트 / Components

| 구분 | 컴포넌트 | 변경 |
|---|---|---|
| common | `Panel` | **신규** — `Card` 대체. `eyebrow`(대문자 라벨) · `title` · `action` · `children`. `.panel/.panel-head/.panel-body` |
| common | `MarketStrip` | **신규** — `TickerBar` 대체. props `{indices, indicators, asOf}` |
| common | `SymbolSearch` | **신규** — 콤보박스(ARIA combobox/listbox). 두 시장 시세를 `useSymbolUniverse(enabled)`로 포커스 시에만 로드. `⌘K`/`Ctrl+K`/`/`로 포커스, ↑↓ Enter Esc |
| common | `Clock` | **신규** — `HH:MM:SS KST` 1초 갱신 |
| common | `MarketStatus` | **신규** — `marketOpen: boolean \| undefined` → 장중/장마감/확인 중 (점 + 라벨) |
| common | `StatusBar` | **신규** — 하단 상태 바 |
| common | `NewsList` | **신규** — `NewsFeed`·`StockNews`가 공유하던 항목 렌더(분석/원문 분기 포함)를 한 곳으로. `a.news-item/.news-title/.news-meta` 클래스 유지 |
| common | `ChangeText` `AsOfBadge` `SimulatedBadge` `Spinner` `ErrorCard` `ThemeToggle` | 동작 불변, 스타일만 |
| common | `Card`, `TickerBar` | **삭제** |
| market | `MarketPulse` | `MarketSummary` 개명 + 밀집 레이아웃 |
| market | `SectorBars` | 스타일만 |
| market | `StockTable` | 시장 탭을 패널 헤더로, 밀집 표, sticky thead, 타뷸러 숫자. 정렬·행 이동·클래스 계약 유지 |
| market | `NewsFeed` | `NewsList` 사용 |
| market | `IndexCards` | **삭제** |
| stock | `Watchlist` | **신규** — `{market, selected}`; `useQuotes(market)` 공유 키 |
| stock | `StockHeader` | 터미널 헤더 + 시가/고가/저가/전일/거래량 행 |
| stock | `PriceChart` | 지표 토글 그룹(`role=group` "지표 선택": MA5·MA20·BOLL·VOL), OHLC 레전드(크로스헤어 구독), 볼린저는 `chartData.ts`의 순수 함수 `bollingerBands(closes, 20, 2)` |
| stock | `OrderBook` | 매도/매수 블록 사이 **현재가 구분행**, 하단 **잔량 합계** 행. 기존 클래스·정렬·막대 비율 계약 유지 |
| stock | `InvestorPanel` `FundamentalCards` `ReturnsRow` `StockNews` `AIPanel` `Week52Bar` | 스타일/껍데기만 (텍스트·role·클래스 계약 유지) |
| lib | `search.ts` | **신규** — `searchSymbols(quotes, query, limit)`: 심볼 정확 > 심볼 접두 > 종목명 접두 > 종목명 포함. `.KS`/`.KQ` 접미사 없이도 매칭 |
| lib | `format.ts` | `formatClock(iso)`(TickerBar에서 이동) + `formatClockSeconds(date)` |
| api | `queries.ts` | `useSymbolUniverse(enabled)` 추가 — `['quotes','us']`·`['quotes','kr']` 키 공유, `enabled` 게이트, 폴링 없음(관찰자 중 짧은 주기가 이긴다) |

## 5. 디자인 토큰 / Design tokens (`tokens.css`)

| 토큰 | 다크(기본) | 라이트 | 용도 |
|---|---|---|---|
| `--bg` | `#0B0E14` | `#EEF1F6` | 페이지 배경 |
| `--panel` | `#11151D` | `#FFFFFF` | 패널 배경 |
| `--panel-raised` | `#171C26` | `#F5F7FB` | 호버·강조 행·입력 배경 |
| `--border` | `#1E2533` | `#D9DEE7` | 패널·행 구분선 |
| `--border-strong` | `#2B3446` | `#B9C2D0` | 포커스·활성 경계 |
| `--text` | `#A6AFC0` | `#4B5565` | 본문 |
| `--text-dim` | `#6B7587` | `#7C8797` | eyebrow·메타 |
| `--text-strong` | `#F2F5FA` | `#111827` | 숫자·제목 |
| `--accent` | `#F2A93B` | `#B8720A` | 선택·포커스·주요 버튼 (앰버) |
| `--accent-soft` | `rgba(242,169,59,.14)` | `rgba(184,114,10,.12)` | 선택 행 배경 |
| `--ok` | `#2FB37A` | `#1E8E5F` | 연결/장중 상태 점 (등락색 아님) |
| `--up` | `#F5445A` | `#DE2B39` | 상승 (유지) |
| `--down` | `#4391FF` | `#2272EB` | 하락 (유지) |
| `--up-soft` / `--down-soft` | 14% 알파 | 12% 알파 | 호가 잔량 막대·등락 배지 배경 |
| `--radius` / `--radius-sm` | `6px` / `4px` | 〃 | 패널 / 버튼·칩 |
| `--font-sans` | Pretendard, 'Noto Sans KR', sans-serif | 〃 | 본문 |
| `--font-mono` | 'JetBrains Mono', ui-monospace, Menlo, monospace | 〃 | 숫자·심볼·시각 |

- **액센트는 앰버**: 하락색이 파랑이므로 파란 액센트는 "선택"과 "하락"이 시각적으로 충돌한다. 앰버는 터미널 관례(Bloomberg)이자 등락색과 겹치지 않는 유일한 고채도 축이다(ADR-001).
- `--card`는 제거한다. `PriceChart.readStyles()`가 읽는 토큰명도 `--panel`/`--border`/`--text-dim`으로 갱신한다.
- `.up/.down/.flat` 클래스와 `ChangeText` 계약은 그대로.

## 6. 데이터 흐름·오류 / Data flow and errors

- 새 컴포넌트도 모두 "위젯이 자기 데이터를 가져간다" 관례를 따른다. 쿼리 키 공유로 요청 수는 늘지 않는다: 종목 상세에서 `Watchlist`의 `useQuotes(market)`가 유일한 추가 요청이며, 45초 폴링 1건이다.
- `SymbolSearch`는 포커스 전에는 아무 요청도 내지 않는다(`enabled: false`). 대시보드에서는 이미 캐시에 있는 시세를 즉시 재사용한다.
- 실패는 위젯 단위 `ErrorCard`(재시도 = 해당 키 invalidate) — 기존 그대로. 셸 요소(`MarketStrip`/`StatusBar`)는 데이터가 없으면 그 부분만 접는다(앱을 막지 않는다).
- 차트의 볼린저/레전드는 캔들이 있을 때만 계산·표시한다. 표본이 20개 미만이면 밴드는 그리지 않는다(빈 시리즈).

## 7. 테스트 / Testing

- 갱신: `App.test`(`.market-strip`, 지표 노출), `main.test`(새 대시보드 문구), `StockDetail.test`(`useQuotes` 모킹 추가), `PriceChart.test`(지표 토글 그룹), `OrderBook.test`(합계 행).
- 신규: `MarketStrip.test`, `SymbolSearch.test`(필터·키보드·이동·포커스 전 요청 없음), `search.test`(순위 규칙), `Clock.test`(형식·KST), `MarketStatus.test`(3분기), `Watchlist.test`(선택 강조·클릭 이동·시장 토글), `NewsList.test`(두 분기), `chartData.test`(볼린저), `StatusBar.test`.
- 삭제: `TickerBar.test`.
- 시각 검증: 로컬 빌드 + Playwright로 3화면 × (1440×900, 390×844) × (다크, 라이트) 스크린샷, 390px에서 `document.scrollingElement.scrollWidth <= 390` 확인.

## 8. 문서 / Docs to sync

- `docs/reference/ui.md`(토큰·터미널 디자인 언어), `docs/reference/frontend.md`(컴포넌트 표·검색·워치리스트), `frontend/CLAUDE.md`, 루트 `CLAUDE.md`(테스트 수), `docs/decisions/ADR-001-terminal-design-language.md`(신규), `docs/superpowers/plans/2026-09-06-terminal-ui-redesign.md`(구현 계획).
