# 터미널 기능 강화 설계 / Terminal Feature Enhancements (Design Spec, Phase 2)

- 작성 / Written: 2026-09-07
- 상태 / Status: 승인(자율 실행 — `/goal` "이미지를 참조해서 기능을 더 강화해주세요") / Approved (autonomous run)
- 선행 / Builds on: `2026-09-06-terminal-ui-redesign-design.md` (ADR-001)
- 참조 / Reference: `img/IMG_6046.JPG`, `img/IMG_6047.JPG`

---

## 1. 목표 / Goal

Phase 1이 **외형**을 터미널로 바꿨다면 Phase 2는 참조 이미지에 보이는 **기능** 중 이 프로젝트의 데이터로 정직하게 구현할 수 있는
것을 추가한다. 원칙은 그대로다: 데이터 소스가 없는 기능은 만들지 않고(가짜 주문·감성 태그 없음), 사용자 상태는 브라우저에만
저장하며(백엔드 무상태 유지), 비용이 드는 경로(AI)는 넓히지 않는다.

| 참조 이미지의 기능 | 채택 | 이 프로젝트의 구현 |
|---|---|---|
| 기간 탭 1M 3M 6M 1Y 5Y 10Y | ✅ 부분 | **6M · 5Y 추가** (백엔드 `PERIOD_MAP`/`CHART_TTL`, 프론트 `ChartPeriod`). 10Y는 주봉 5Y로 충분 |
| RSI(14) · MACD 서브 패널 | ✅ | 메인 차트 아래 **동기화된 보조 차트**(lightweight-charts v4는 단일 패널 → 두 번째 차트 + 논리 범위 동기화) |
| 캔들 / 데이터 표 토글 | ✅ | `CandleTable` — 최신순 OHLCV + 등락률 표 |
| BOLL(20,2) | ✅ Phase 1 | — |
| 차트 기준선 | ✅ | 전일종가 · 52주 고/저 가격선 토글(`LVL`), 상세 데이터에서 전달 |
| NEWS WIRE 탭(전체/종목/…) · EN/KO | ✅ | 시장 뉴스: **전체 · 한국어 · English** 탭 + 제목 키워드 필터 |
| MY WATCHLIST · 관리 | ✅ | **관심 종목**(★) — localStorage, 시세 표·워치리스트 레일·종목 헤더에서 토글, `관심` 스코프 탭 |
| ETF PERFORMANCE 막대 | ✅ 변형 | **MACRO** 패널 — 경제지표 11개를 등락률 막대로(크롤 대신 읽을 수 있는 형태) |
| 알림 (status line "알림 30초") | ✅ | **가격 알림** — 목표가 상향/하향 돌파 시 토스트(브라우저 알림 권한이 있으면 시스템 알림). 시세 폴링 데이터로 판정 |
| 레이아웃 초기화 · 패널 접기 | ✅ | 패널 접기(localStorage) + 상태 바의 **레이아웃 초기화** |
| ORDER & EXECUTION | ❌ | 주문 경로 없음 — 참조도 "연결되지 않았습니다"라 표시. 빈 패널을 두지 않는다(ADR-001) |
| AI 질문 입력(자유 질의) | ❌ 보류 | 백엔드 프롬프트·캐시 키·비용 방어 재설계 필요 — 별도 스펙 |
| 감성 태그 · 옵션 플로우 · 시나리오 · 포트폴리오 리스크 | ❌ | 데이터 소스 없음 |

## 2. 설계 / Design

### 2.1 차트 기간 6M · 5Y (백엔드 + 프론트)
- `charts.PERIOD_MAP`: `"6m": ("6mo", "1d")`, `"5y": ("5y", "1wk")`. 5Y는 주봉 — 일봉 5년(≈1,260 캔들)은 응답 크기와 MA 의미가
  모두 나빠진다. `CHART_TTL`: `6m` 21600(6h), `5y` 86400(24h). `api/stocks.py`의 `Period` Literal에 두 값 추가(테스트가 `CHART_TTL` 키
  일치를 검증하므로 함께 갱신). `fetch_chart`의 Literal도 동일.
- 프론트: `types.ts`에 `ChartPeriod = Period | '6m' | '5y'` (기간수익률 `returns`는 여전히 `Period` 4개). `PriceChart` 탭
  `1W 1M 3M 6M 1Y 5Y`. `useChart(symbol, ChartPeriod)`.

### 2.2 RSI · MACD 서브 패널
- `indicators.ts`: `rsi(closes, 14)`(Wilder 평활), `macd(closes, 12, 26, 9)` → `{macd, signal, histogram}`. 워밍업 구간 null. 테스트.
- `PriceChart`: 지표 토글에 `RSI`, `MACD` 추가(기본 off). 켜지면 메인 차트 아래 높이 110px의 보조 차트를 각각 만든다
  (`createChart`, 같은 토큰). **시간축 동기화**: 메인 ↔ 보조 `timeScale().subscribeVisibleLogicalRangeChange`로 양방향, 재진입 가드.
  보조 차트는 시간축 라벨을 숨기고(메인이 보여줌) 오른쪽 가격축 폭을 메인과 맞춘다(`rightPriceScale.minimumWidth`).
- RSI 패널: 라인 + 30/70 기준선(`createPriceLine`). MACD 패널: 히스토그램(방향색 연한 톤) + MACD/시그널 라인.

### 2.3 데이터 표 · 기준선
- 뷰 토글 `캔들 | 표`(`role=group` "표시 방식"). 표는 `CandleTable`: 날짜·시가·고가·저가·종가·등락률·거래량, 최신순, 패널 안 스크롤(최대 360px).
- `PriceChart`에 `levels?: { prevClose?: number; week52High?: number; week52Low?: number }` 프롭. 토글 `LVL`(기본 on)로
  `candles.createPriceLine` 3개(점선, 라벨 `전일`, `52H`, `52L`). 0 센티널은 그리지 않는다. `StockDetail`이 상세에서 전달.

### 2.4 뉴스 와이어 필터
- `NewsFeed`: 패널 머리에 `전체 · 한국어 · English` 토글(`role=group` "뉴스 필터") + 키워드 입력(제목 포함 검색, 대소문자 무시).
  필터 결과 0건이면 "조건에 맞는 뉴스가 없습니다". 카운트 뱃지는 필터 후 건수.
- 순수 함수 `filterNews(items, {language, query})` (`lib/newsFilter.ts`) + 테스트.

### 2.5 관심 종목 (MY WATCHLIST)
- `lib/watchlistStore.ts`: localStorage 키 `stock-monitoring:watchlist`(심볼 배열), `useWatchlist()` → `{symbols, has, toggle}`
  (`useSyncExternalStore`, 같은 탭 내 구독 + `storage` 이벤트로 다른 탭 동기화). 저장 실패는 세션 동안만 유지.
- UI: 시세 표 첫 열 ★ 버튼(`aria-pressed`, 행 클릭 이동과 분리 — `stopPropagation`), 종목 헤더 ★ 버튼, 워치리스트 레일.
- 스코프 탭: `MarketTabs`를 `ScopeTabs`로 확장 — `미국 · 한국 · ★관심`(`QuoteScope = Market | 'watch'`). `관심` 스코프는
  `useSymbolUniverse(true)`에서 저장된 심볼만 골라 보여준다(저장 순서). 비어 있으면 "★를 눌러 관심 종목을 추가하세요".
  시장 화면의 펄스·섹터는 `watch` 스코프에서 마지막 시장을 유지한다(시장별 데이터라 관심 스코프가 없다).

### 2.6 MACRO 패널
- `MacroPanel`: `useOverview().indicators`를 |등락률| 내림차순 막대(`SectorBars`와 같은 문법)로. 이름 · 값(단위) · 등락률.
- 시장 화면 그리드: 1행 `pulse | sectors | macro`, 2행 `quotes(3칸)`, 우측 열 `news`(두 행 span). ≤1199: `pulse sectors / macro news / quotes quotes`. ≤899: 1열.

### 2.7 가격 알림
- `lib/alertsStore.ts`: localStorage 키 `stock-monitoring:alerts` — `{ id, symbol, price, direction: 'above'|'below', createdAt, triggeredAt? }`.
  순수 판정 `evaluateAlerts(alerts, quotes, now)` → 새로 발동한 알림 목록(발동은 1회, `triggeredAt` 기록). 테스트.
- UI: 종목 헤더의 `알림` 버튼 → 인라인 폼(목표가, 방향 자동: 현재가보다 높으면 상향 돌파). `AlertsWatcher`(셸)가 `useSymbolUniverse(활성 알림 존재)`
  로 시세를 받아 폴링마다 판정 → 토스트(`role=status`, 8초) + `Notification` 권한이 granted면 시스템 알림. 상태 바에 `알림 N` 카운트.
- 알림 목록/삭제는 종목 헤더 폼 안(그 종목의 알림만) — 별도 관리 화면은 만들지 않는다(YAGNI).

### 2.8 패널 접기 · 레이아웃 초기화
- `Panel`에 `id?: string` — 있으면 머리에 접기 버튼(`aria-expanded`), 접힘 상태는 `stock-monitoring:panels` localStorage.
  접힌 패널은 머리만 남는다. 상태 바 우측 `레이아웃 초기화` 버튼이 접힘 상태를 모두 지운다. 접기 대상: 시장·종목 화면의 위젯 패널
  (셸 요소·헤더·에러 카드 제외).

## 3. 데이터·오류 / Data and errors
- 새 요청은 6M/5Y 차트 하나뿐(사용자가 탭을 눌렀을 때). 관심·알림은 이미 있는 `['quotes', market]` 캐시를 읽는다.
- localStorage 접근은 모두 try/catch — 읽기 실패는 빈 상태, 쓰기 실패는 세션 메모리로 동작(ThemeToggle과 같은 규칙).
- 보조 차트는 메인 차트가 있을 때만 존재하고 토글이 꺼지면 파괴된다. 데이터 부족(RSI 워밍업 14, MACD 26+9)이면 빈 시리즈.

## 4. 테스트 / Testing
- 백엔드: `test_config`/`test_api_stocks`/`test_charts`의 기간 집합 갱신 + `6m`·`5y` 매핑 테스트.
- 프론트 신규: `indicators.test`(rsi·macd), `newsFilter.test`, `watchlistStore.test`, `alertsStore.test`(evaluateAlerts), `CandleTable.test`,
  `MacroPanel.test`, `ScopeTabs`/`StockTable`(관심 스코프·★ 토글), `NewsFeed`(필터), `Panel`(접기), `PriceChart`(새 탭·토글·뷰 전환).
- 시각 검증: 로컬 빌드 + 스크린샷(종목 화면 RSI/MACD on, 표 뷰, 관심 스코프, 알림 폼).

## 5. 문서 / Docs to sync
`docs/reference/api.md`(기간 집합), `data.md`(TTL 표), `frontend.md`, `ui.md`, `frontend/CLAUDE.md`, 루트 `CLAUDE.md`(테스트 수).
