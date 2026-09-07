# UI / UI 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
The visual layer is a **terminal design language** (ADR-001, 2026-09-06), referenced from the two screenshots in `img/` (a Korean Seoul-Terminal-style workspace and Bloomberg Terminal): a viewport-filling workspace grid of 1px-bordered, 6px-radius panels with small uppercase "eyebrow" headers, a fixed market strip under the command bar, a watchlist rail on the stock screen, a bottom status bar, and monospaced numerals (JetBrains Mono) next to Pretendard body text. Dark is the default theme, light is a "terminal on paper" variant with the same density; both are driven entirely by CSS custom properties in `tokens.css` and switched only via `<html data-theme="dark|light">`. Price movement follows the **Korean market convention — up is red, down is blue** (the reference images' Western green/red was deliberately not adopted), and flat (exactly 0) uses the body colour. The accent is **amber**, chosen so that "selected" never shares a hue with "falling" (blue).

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Design tokens | `frontend/src/styles/tokens.css` | Per-theme palette (`--bg`, `--panel`, `--panel-raised`, `--border`, `--border-strong`, `--text`, `--text-dim`, `--text-strong`, `--accent`, `--accent-soft`, `--accent-ink`, `--ok`, `--up`, `--down`, `--up-soft`, `--down-soft`, chart series `--chart-*`), structural tokens (`--radius`, `--radius-sm`, `--shadow`, `--font-sans`, `--font-mono`, `--term-top-h`, `--term-status-h`, `--ws-gap`), and the `.up`/`.down`/`.flat` classes |
| Global styles | `frontend/src/styles/global.css` | Shell (`.terminal/.term-top/.term-main`), command bar, market strip, status bar, `Panel`, buttons/tabs/badges, workspace grids (`.ws-market`, `.ws-stock`), watchlist rail, quote header, stat cells, tables, news wire, chart toolbar/legend, order book, investor flow, markdown, responsive breakpoints (1279 / 1199 / 899 / 560 px), reduced motion |
| Panel | `frontend/src/components/common/Panel.tsx` | The widget shell: eyebrow (uppercase mono label) + Korean title + right-side actions; `flush` drops the body padding for tables/lists; an `id` adds the ▾/▸ collapse toggle (state in localStorage, reset from the status bar) |
| Stat | `frontend/src/components/common/Stat.tsx` | Label-over-value cell used by the quote header, fundamentals and period returns |
| MarketStrip | `frontend/src/components/common/MarketStrip.tsx` | Indices as fixed cells + indicators as an aria-hidden-duplicated crawl + as-of chip |
| StatusBar / MarketStatus / Clock | `frontend/src/components/common/` | Bottom bar: open/closed/unknown dot (`--ok` is state-only, never a price colour), source, polling cadence from the constants, simulation notice, pending-alert count, an offline badge (`lib/online.ts`, shown while `navigator.onLine` is false — the PWA shell opens offline, so the bar says why data stopped), layout reset, as-of, KST clock. System toasts from the service worker (`UpdateToast`: new version → "새로 고침", offline ready) sit bottom-left (`.toasts-left`) on desktop and under the sticky top block on ≤899px; both stacks anchor to the blocks' measured heights (`--sticky-top-h` / `--sticky-bottom-h` from `lib/stickyOffsets.ts`), never to the desktop tokens, because the bar and the top block wrap on narrow screens; secondary status chips hide at ≤560px |
| StarButton / AlertsWatcher | `frontend/src/components/common/` | The ★ watchlist toggle (amber when on) and the fixed bottom-right toast stack for fired price alerts (`role=status`, accent left rule) |
| ThemeToggle | `frontend/src/components/common/ThemeToggle.tsx` | Flips `data-theme` on `<html>` (dark is the default) |
| ChangeText | `frontend/src/components/common/ChangeText.tsx` | The single place that maps a change *amount* to `.up`/`.down`/`.flat`; percentage-only cells compose `arrow` + `changeClass` + `formatPct` directly |
| Status badges | `AsOfBadge.tsx`, `SimulatedBadge.tsx` | Data freshness (`asOf`) and the mandatory "simulated data" label |
| Price chart | `frontend/src/components/stock/PriceChart.tsx` | lightweight-charts candles + MA5/MA20 + Bollinger + golden/dead-cross markers; period tabs 1W/1M/3M/6M/1Y/5Y (5Y weekly); toggles MA5/MA20/BOLL/VOL/LVL/RSI/MACD — LVL draws dotted reference lines (previous close, 52-week high/low), VOL (direction-tinted volume), RSI 14 and MACD 12·26·9 are separate `createChart` sub-panes whose time scale and crosshair are synced with the main chart (the volume left the main pane and the candle series clamps its autoscale floor at 0 with price-unit padding below — the old 26% pixel band printed 0 / negative labels on 5Y, and a pixel margin of any size would still on symbols whose range is many times their low); an OHLC legend follows the hovered candle and a 캔들/표 switch swaps the canvas for `CandleTable`. Reads `--up/--down/--chart-*/--panel/--border/--border-strong/--text-dim/--text-strong/--font-mono` via `getComputedStyle` (the one sanctioned colour exception) and rebuilds on a theme change |
| Fonts | `@fontsource/pretendard` (400/700), `@fontsource/jetbrains-mono` (latin 400/700) | Pretendard for text, JetBrains Mono for numbers, symbols and clocks; both self-hosted through the bundle |

### 3. Key Decisions
- **Up = red (`--up`), down = blue (`--down`), flat = body colour** — the Korean market convention; reversing this (Western green/red) is a correctness bug here, not a style choice. The reference terminals use green/red and were not followed on this point.
- **Amber accent** (`#F2A93B` dark / `#B8720A` light): with blue as the down colour, a blue accent would put "selected" and "falling" on one axis in the watchlist and tables. Amber is also the classic terminal accent. `--ok` (green) exists for the market-state dot only and must never colour a price move.
- **Never hardcode colours in components** — always the `tokens.css` variables. Canvas is the exception: `PriceChart` reads token *values* by name. The volume tints (`--chart-vol-up/down`) use comma `rgba()` because they are handed to the canvas colour parser.
- **Theme switches only via `<html data-theme>`**, with `color-scheme` per theme so native controls follow; dark is the default.
- **Density over decoration**: 13px body, 6px panel radius, 8px workspace gap, 1px borders, `tabular-nums` everywhere; panel heads never shrink (`flex-shrink: 0`) so wrapped actions cannot spill over the first row of a height-capped panel.
- **Indices live in the market strip**, not in cards: they are visible on every screen, and the dashboard's first row is freed for pulse, sectors and news.
- **Simulated data is visually labelled** (`SimulatedBadge`) wherever the order book / investor flows render — mirrors the API's `"simulated": true`.
- **Structural tokens are measured, not derived**: `--term-top-h` (85px = command bar 44 + strip 40 + rule) caps the sticky rail and news column; re-measure it when the top block changes.

### 4. Code Pointers
- `frontend/src/styles/tokens.css` — the complete token set and the up/down/flat classes (the header states the hardcoding ban and the amber rationale)
- `frontend/src/styles/global.css` — shell, panel, grid and widget styling; the breakpoints and the reduced-motion block
- `frontend/src/components/common/Panel.tsx` — the panel contract every widget uses
- `frontend/src/components/common/ChangeText.tsx` + `ChangeText.test.tsx` — the change→class mapping and its contract
- `frontend/src/components/stock/PriceChart.tsx` — `readStyles()`: how the chart picks up theme tokens
- `docs/decisions/ADR-001-terminal-design-language.md` — why the terminal language and the amber accent

### 5. Cross-references
- Related modules: [frontend.md](frontend.md) (component structure), [api.md](api.md) (the `simulated` flag the badges mirror)
- Related ADRs: [ADR-001](../decisions/ADR-001-terminal-design-language.md); design spec `docs/superpowers/specs/2026-09-06-terminal-ui-redesign-design.md`
- Related runbooks: none yet

<a id="korean"></a>
## 한국어

### 1. 개요
비주얼 계층은 **터미널 디자인 언어**다 (ADR-001, 2026-09-06). `img/`의 참조 이미지 두 장(한국어 Seoul Terminal 스타일 워크스페이스, Bloomberg Terminal)에서 가져왔다: 뷰포트를 가득 채우는 워크스페이스 그리드, 1px 테두리·6px 라운드 패널과 대문자 소형 "eyebrow" 헤더, 커맨드 바 아래 고정 마켓 스트립, 종목 화면의 워치리스트 레일, 하단 상태 바, Pretendard 본문 옆의 고정폭 숫자(JetBrains Mono). 다크가 기본이고 라이트는 밀도가 같은 "종이 위의 터미널"이다. 전부 `tokens.css`의 CSS 커스텀 프로퍼티로 구동되며 테마 전환은 `<html data-theme="dark|light">`로만 한다. 등락 표시는 **한국 관례 — 상승=빨강, 하락=파랑**(참조 이미지의 서구식 초록/빨강은 의도적으로 채택하지 않았다)이고 보합(정확히 0)은 본문색. 액센트는 **앰버** — "선택됨"이 "하락"(파랑)과 같은 색축을 쓰지 않게 하기 위해서다.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 디자인 토큰 | `frontend/src/styles/tokens.css` | 테마별 팔레트(`--bg`, `--panel`, `--panel-raised`, `--border`, `--border-strong`, `--text`, `--text-dim`, `--text-strong`, `--accent`, `--accent-soft`, `--accent-ink`, `--ok`, `--up`, `--down`, `--up-soft`, `--down-soft`, 차트 시리즈 `--chart-*`), 구조 토큰(`--radius`, `--radius-sm`, `--shadow`, `--font-sans`, `--font-mono`, `--term-top-h`, `--term-status-h`, `--ws-gap`), `.up`/`.down`/`.flat` 클래스 |
| 전역 스타일 | `frontend/src/styles/global.css` | 셸(`.terminal/.term-top/.term-main`), 커맨드 바, 마켓 스트립, 상태 바, `Panel`, 버튼/탭/뱃지, 워크스페이스 그리드(`.ws-market`, `.ws-stock`), 워치리스트 레일, 종목 헤더, 통계 셀, 표, 뉴스 와이어, 차트 툴바/레전드, 호가, 수급, 마크다운, 반응형(1279 / 1199 / 899 / 560 px), 모션 최소화 |
| Panel | `frontend/src/components/common/Panel.tsx` | 위젯 껍데기: eyebrow(대문자 고정폭 라벨) + 한국어 제목 + 우측 액션. `flush`는 표·목록용으로 본문 패딩 제거. `id`가 있으면 ▾/▸ 접기 토글(localStorage, 상태 바에서 초기화) |
| Stat | `frontend/src/components/common/Stat.tsx` | 라벨 위·값 아래 셀 — 종목 헤더·핵심 지표·기간수익률 공용 |
| MarketStrip | `frontend/src/components/common/MarketStrip.tsx` | 지수 고정 셀 + 지표 크롤(aria-hidden 사본 1벌) + 기준 시각 칩 |
| StatusBar / MarketStatus / Clock | `frontend/src/components/common/` | 하단 바: 장중/장마감/확인 중 점(`--ok`는 상태 전용, 등락색 아님), 출처, 상수에서 읽은 폴링 주기, 시뮬레이션 안내, 대기 알림 수, 오프라인 배지(`lib/online.ts` — `navigator.onLine`이 false인 동안. PWA 셸은 오프라인에서도 열리므로 데이터가 멈춘 이유를 바가 말한다), 레이아웃 초기화, 기준 시각, KST 시계. 서비스 워커의 시스템 토스트(`UpdateToast`: 새 버전 → "새로 고침", 오프라인 준비)는 데스크톱에서는 왼쪽 아래(`.toasts-left`), 899px 이하에서는 상단 고정 블록 아래에 둔다. 두 스택은 블록의 실측 높이(`lib/stickyOffsets.ts`의 `--sticky-top-h` / `--sticky-bottom-h`)에 붙는다 — 토큰은 데스크톱 값이고 바·상단 블록은 좁은 화면에서 줄바꿈한다. 부차 상태 칩은 560px 이하에서 숨긴다 |
| StarButton / AlertsWatcher | `frontend/src/components/common/` | ★ 관심 종목 토글(켜지면 앰버)과 발동한 가격 알림의 우하단 토스트 스택(`role=status`, 액센트 왼쪽 선) |
| ThemeToggle | `frontend/src/components/common/ThemeToggle.tsx` | `<html>`의 `data-theme` 전환 (기본은 다크) |
| ChangeText | `frontend/src/components/common/ChangeText.tsx` | 등락 *금액*을 `.up`/`.down`/`.flat`으로 매핑하는 유일한 지점. 퍼센트만 있는 셀은 `arrow` + `changeClass` + `formatPct`를 직접 조합 |
| 상태 배지 | `AsOfBadge.tsx`, `SimulatedBadge.tsx` | 데이터 신선도(`asOf`)와 의무적인 "시뮬레이션" 표시 |
| 가격 차트 | `frontend/src/components/stock/PriceChart.tsx` | lightweight-charts 캔들 + MA5/MA20 + 볼린저 + 골든/데드 크로스 마커. 기간 탭 1W/1M/3M/6M/1Y/5Y(5Y는 주봉), 토글 MA5/MA20/BOLL/VOL/LVL/RSI/MACD — LVL은 점선 기준선(전일 종가·52주 고/저), VOL(방향색 거래량)·RSI 14·MACD 12·26·9는 시간축·크로스헤어가 메인과 동기화된 별도 `createChart` 보조 패널(거래량을 메인에서 빼내고 캔들 시리즈가 autoscale 바닥을 0에서 클램프하며 아래 여백은 가격 단위로 준다 — 옛 26% 픽셀 띠가 5Y에서 0·음수 라벨을 만들었고, 픽셀 여백은 크기가 얼마든 범위가 최저가의 수십 배인 종목에서 같은 일을 한다). OHLC 레전드가 호버 캔들을 따르고 캔들/표 토글은 캔버스를 `CandleTable`로 바꾼다. `--up/--down/--chart-*/--panel/--border/--border-strong/--text-dim/--text-strong/--font-mono`를 `getComputedStyle`로 읽는다(승인된 유일한 색 예외), 테마가 바뀌면 재생성 |
| 폰트 | `@fontsource/pretendard`(400/700), `@fontsource/jetbrains-mono`(latin 400/700) | 본문은 Pretendard, 숫자·심볼·시각은 JetBrains Mono. 둘 다 번들로 셀프 호스팅 |

### 3. 주요 결정
- **상승=빨강(`--up`), 하락=파랑(`--down`), 보합=본문색** — 한국 시장 관례. 이를 뒤집는 것(서구식 초록/빨강)은 스타일 취향이 아니라 **정확성 버그**다. 참조 터미널은 초록/빨강을 쓰지만 이 점은 따르지 않았다.
- **앰버 액센트**(`#F2A93B` 다크 / `#B8720A` 라이트): 하락색이 파랑이라 파란 액센트는 워치리스트·표에서 "선택됨"과 "하락"을 같은 색축에 놓는다. 앰버는 터미널의 고전적 액센트이기도 하다. `--ok`(초록)는 장 상태 점 전용이며 등락에 절대 쓰지 않는다.
- **컴포넌트에서 색상 하드코딩 금지** — 항상 `tokens.css` 변수. canvas만 예외로 `PriceChart`가 토큰 *값*을 이름으로 읽는다. 거래량 색(`--chart-vol-up/down`)은 canvas 색 파서에 넘어가므로 쉼표 `rgba()` 표기다.
- **테마는 `<html data-theme>`로만 전환**, 테마별 `color-scheme` 설정으로 네이티브 컨트롤도 따라온다. 기본은 다크.
- **장식보다 밀도**: 본문 13px, 패널 라운드 6px, 워크스페이스 간격 8px, 1px 테두리, 전역 `tabular-nums`. 패널 머리는 줄어들지 않는다(`flex-shrink: 0`) — 높이 제한 패널에서 줄바꿈된 액션이 첫 행 위로 흘러넘치지 않게.
- **지수는 마켓 스트립에** 산다(카드 아님): 모든 화면에서 보이고, 시장 화면 첫 행이 펄스·섹터·뉴스에 쓰인다.
- **시뮬레이션 데이터는 시각적으로 표시**(`SimulatedBadge`) — 호가/수급 렌더링마다, API의 `"simulated": true`를 그대로 반영.
- **구조 토큰은 유도하지 않고 실측한다**: `--term-top-h`(85px = 커맨드 바 44 + 스트립 40 + 경계선)가 sticky 레일·뉴스 열의 높이 상한을 정한다. 상단 구성이 바뀌면 다시 측정한다.

### 4. 코드 포인터
- `frontend/src/styles/tokens.css` — 전체 토큰 세트와 up/down/flat 클래스 (파일 머리에 하드코딩 금지와 앰버 근거 명시)
- `frontend/src/styles/global.css` — 셸·패널·그리드·위젯 스타일, 브레이크포인트, 모션 최소화 블록
- `frontend/src/components/common/Panel.tsx` — 모든 위젯이 쓰는 패널 계약
- `frontend/src/components/common/ChangeText.tsx` + `ChangeText.test.tsx` — 등락→클래스 매핑과 그 계약
- `frontend/src/components/stock/PriceChart.tsx` — `readStyles()`: 차트가 테마 토큰을 받는 방식
- `docs/decisions/ADR-001-terminal-design-language.md` — 터미널 언어와 앰버 액센트를 택한 이유

### 5. 상호 참조
- 관련 모듈: [frontend.md](frontend.md) (컴포넌트 구조), [api.md](api.md) (배지가 반영하는 `simulated` 플래그)
- 관련 ADR: [ADR-001](../decisions/ADR-001-terminal-design-language.md); 설계 스펙 `docs/superpowers/specs/2026-09-06-terminal-ui-redesign-design.md`
- 관련 런북: 아직 없음
