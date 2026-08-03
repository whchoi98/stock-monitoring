# UI / UI 구현 상세

[![English](https://img.shields.io/badge/Language-English-blue)](#english)
[![한국어](https://img.shields.io/badge/Language-한국어-red)](#korean)

<a id="english"></a>
## English

### 1. Overview
The visual layer is a Toss Invest-referenced design: dark theme by default with a light theme, driven entirely by CSS custom properties in `tokens.css` and switched only via `<html data-theme="dark|light">`. Price movement follows the **Korean market convention — up is red, down is blue** (the opposite of Western dashboards), and flat (exactly 0) uses the body color. The typeface is Pretendard.

### 2. Components
| Component | Path | Purpose |
|---|---|---|
| Design tokens | `frontend/src/styles/tokens.css` | All theme variables (`--bg`, `--card`, `--up`, `--down`, `--accent`, `--text`, `--text-strong`, `--radius`) per `data-theme`, plus the `.up`/`.down`/`.flat` classes |
| Global styles | `frontend/src/styles/global.css` | App shell layout, cards, tables, page-level styling built on the tokens |
| ThemeToggle | `frontend/src/components/common/ThemeToggle.tsx` | Switches `data-theme` on `<html>` (dark is the default) |
| ChangeText | `frontend/src/components/common/ChangeText.tsx` | The single place that maps a change value to `.up`/`.down`/`.flat` |
| Status badges | `frontend/src/components/common/AsOfBadge.tsx`, `SimulatedBadge.tsx` | Data freshness (`asOf`) and the "simulated data" label |
| Price chart | `frontend/src/components/stock/PriceChart.tsx` | lightweight-charts candles + MA5/MA20, colored from the same tokens |
| Font | `@fontsource/pretendard` (`frontend/package.json`) | Pretendard, self-hosted through the bundle |

### 3. Key Decisions
- **Up = red (`--up`), down = blue (`--down`), flat = body color** — the Korean market convention; reversing this (Western green/red) is a correctness bug here, not a style choice.
- **Never hardcode colors in components** — always the `tokens.css` variables; the dark/light values differ (e.g. `--up` `#F5445A` dark / `#DE2B39` light).
- **Theme switches only via `<html data-theme>`**, with `color-scheme` set per theme so native controls follow; dark is the default.
- **Toss Invest-measured values**: the token values were taken from Toss Invest as the visual reference; `--radius: 16px` cards throughout.
- **Simulated data is visually labeled** (`SimulatedBadge`) wherever order book / investor flows render — mirrors the API's `"simulated": true`.

### 4. Code Pointers
- `frontend/src/styles/tokens.css` — the complete token set and the up/down/flat classes (the file header states the hardcoding ban)
- `frontend/src/components/common/ChangeText.tsx` + `ChangeText.test.tsx` — the change→class mapping and its contract
- `frontend/src/components/common/ThemeToggle.tsx` + `ThemeToggle.test.tsx` — theme switching behavior
- `frontend/src/styles/global.css` — shell/card/table styling conventions
- `frontend/src/components/stock/PriceChart.tsx` — how chart series pick up theme colors

### 5. Cross-references
- Related modules: [frontend.md](frontend.md) (component structure), [api.md](api.md) (the `simulated` flag the badges mirror)
- Related ADRs: none yet — design spec `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- Related runbooks: none yet

<a id="korean"></a>
## 한국어

### 1. 개요
비주얼 계층은 Toss Invest를 참조한 디자인이다: 다크 테마가 기본, 라이트 테마 지원. 전부 `tokens.css`의 CSS 커스텀 프로퍼티로 구동되며 테마 전환은 `<html data-theme="dark|light">`로만 한다. 등락 표시는 **한국 관례 — 상승=빨강, 하락=파랑** (서구 대시보드와 반대)이고, 보합(정확히 0)은 본문색을 쓴다. 서체는 Pretendard.

### 2. 구성요소
| 구성요소 | 경로 | 목적 |
|---|---|---|
| 디자인 토큰 | `frontend/src/styles/tokens.css` | `data-theme`별 전체 테마 변수(`--bg`, `--card`, `--up`, `--down`, `--accent`, `--text`, `--text-strong`, `--radius`) + `.up`/`.down`/`.flat` 클래스 |
| 전역 스타일 | `frontend/src/styles/global.css` | 토큰 위에 구축한 앱 셸 레이아웃, 카드, 테이블, 페이지 스타일 |
| ThemeToggle | `frontend/src/components/common/ThemeToggle.tsx` | `<html>`의 `data-theme` 전환 (기본은 다크) |
| ChangeText | `frontend/src/components/common/ChangeText.tsx` | 등락 값을 `.up`/`.down`/`.flat`으로 매핑하는 유일한 지점 |
| 상태 배지 | `frontend/src/components/common/AsOfBadge.tsx`, `SimulatedBadge.tsx` | 데이터 신선도(`asOf`)와 "시뮬레이션 데이터" 표시 |
| 가격 차트 | `frontend/src/components/stock/PriceChart.tsx` | lightweight-charts 캔들 + MA5/MA20, 같은 토큰으로 색상 지정 |
| 폰트 | `@fontsource/pretendard` (`frontend/package.json`) | Pretendard, 번들로 셀프 호스팅 |

### 3. 주요 결정
- **상승=빨강(`--up`), 하락=파랑(`--down`), 보합=본문색** — 한국 시장 관례. 이를 뒤집는 것(서구식 초록/빨강)은 스타일 취향이 아니라 **정확성 버그**다.
- **컴포넌트에서 색상 하드코딩 금지** — 항상 `tokens.css` 변수 사용. 다크/라이트 값이 다르다 (예: `--up` 다크 `#F5445A` / 라이트 `#DE2B39`).
- **테마는 `<html data-theme>`로만 전환**, 테마별 `color-scheme` 설정으로 네이티브 컨트롤도 따라온다. 기본은 다크.
- **Toss Invest 실측 값**: 토큰 값은 Toss Invest를 비주얼 레퍼런스로 실측했다. 카드 `--radius: 16px` 일관 적용.
- **시뮬레이션 데이터는 시각적으로 표시** (`SimulatedBadge`) — 호가/수급 렌더링마다, API의 `"simulated": true`를 그대로 반영.

### 4. 코드 포인터
- `frontend/src/styles/tokens.css` — 전체 토큰 세트와 up/down/flat 클래스 (파일 헤더에 하드코딩 금지 명시)
- `frontend/src/components/common/ChangeText.tsx` + `ChangeText.test.tsx` — 등락→클래스 매핑과 그 계약
- `frontend/src/components/common/ThemeToggle.tsx` + `ThemeToggle.test.tsx` — 테마 전환 동작
- `frontend/src/styles/global.css` — 셸/카드/테이블 스타일 컨벤션
- `frontend/src/components/stock/PriceChart.tsx` — 차트 시리즈가 테마 색을 받는 방식

### 5. 상호 참조
- 관련 모듈: [frontend.md](frontend.md) (컴포넌트 구조), [api.md](api.md) (배지가 반영하는 `simulated` 플래그)
- 관련 ADR: 아직 없음 — 설계 스펙 `docs/superpowers/specs/2026-08-01-stock-monitoring-design.md`
- 관련 런북: 아직 없음
