# 경제 지표 상단 sticky 티커 + 전체 모바일 검증 — 설계 스펙

- 날짜: 2026-08-03 (사용자 승인)
- 배경: stock-on-tui는 상단 IndicatorBar로 경제 지표를 보여준다. 웹(stock-monitoring)은 같은 11개
  지표(WTI·Gold·Silver·Copper·EUR/USD·USD/KRW·USD/JPY·USD/CNY·미10년물·BTC·ETH)를 이미
  `overview.indicators`로 서빙하고 **하단 fixed 무한스크롤 티커**로 표시 중이다.
- 요청: ① 지표를 상단으로 (TUI 위계) ② 앱 전체가 모바일에서도 잘 보이는지 확인.

## 사용자 결정 (2026-08-03)

| 결정 | 선택 |
|---|---|
| 배치 | **하단 티커를 상단으로 이동** (신설/중복 아님) |
| 상단 방식 | **헤더 아래 sticky** — 헤더+티커가 함께 상단 고정 (아래 정정 참고) |
| 업데이트 시각 | **상단에 상시 표기** (사용자 추가 요구 2026-08-03) — 티커 우측 고정 칩 |
| 모바일 범위 | **앱 전체 검증** (티커만이 아님) |

> **정정 (설계 제시 때의 미리보기와 다른 점)**: 헤더 `.app-nav`는 이미 `position: sticky; top: 0`
> 이다 — "스크롤 시 헤더가 올라간다"는 미리보기 문구가 사실과 달랐다. 기존 앱의 헤더 상시 노출
> 동작을 바꾸지 않기 위해 **헤더와 티커를 하나의 sticky 블록으로 묶는다** (아래 §1). 결과: 스크롤
> 시 헤더+티커 모두 상단 고정. 모바일 세로 공간 소비 약 90px — 수용 기준 ①~④로 검증한다.

## 1. 티커 재배치 — 프론트엔드 전용, 백엔드 변경 0

- `frontend/src/App.tsx`: `<header className="app-nav">`와 `<TickerBar>`를
  `<div className="app-top">` 하나로 감싼다 (main 앞). 데이터 흐름 무변경 — 셸의 `useOverview()`
  → prop, 빈 배열이면 티커가 스스로 `null` 반환(기존 동작 유지, 헤더만 남음).
- `frontend/src/styles/global.css`:
  - 신설 `.app-top { position: sticky; top: 0; z-index: 10; }` — 헤더+티커가 한 블록으로 고정.
    높이 계산(매직 넘버) 없이 두 요소가 함께 붙는 가장 단순한 방법.
  - `.app-nav`의 `position: sticky; top: 0; z-index: 10` 제거 (래퍼가 대신함).
    부작용: `RouteError` 셸은 `.app-nav`를 직접 쓰므로 그 헤더는 정적이 된다 — 에러 화면이라 무해.
  - `.ticker-bar`: `position: fixed; right/bottom/left: 0; z-index: 10` 제거(래퍼 안 흐름 배치),
    `border-top` → `border-bottom` (아래 콘텐츠와의 구분선).
- `.app`의 `padding-bottom: 56px`(하단 fixed 티커 자리 확보용, global.css 57행 부근) 제거.
- 마키 애니메이션(트랙 -50% 순환), `aria-hidden` 시각용 사본, `prefers-reduced-motion` 처리
  (global.css 1130행 부근)는 **변경 없이 재사용**.
- `RouteError` 셸(App.tsx 내 독립 레이아웃)은 티커를 렌더하지 않음 — 변경 대상 아님.

### 업데이트 시각 표기 (사용자 추가 요구)
- `TickerBar`에 `asOf?: string` prop 추가 (셸이 `data?.asOf` 전달). 티커 **우측 고정 칩**으로
  `HH:MM 기준`을 상시 표기 — 마키는 칩 왼쪽 영역에서만 순환.
  (정정 2026-08-03: `asOf`는 envelope 필드로 `useOverview()`가 `data`의 형제로 언랩 —
  `const { data, asOf } = useOverview()`. 원문 `data?.asOf`는 TS2339.)
  - 형식: 브라우저 로컬 시간대 `HH:MM` (`Intl.DateTimeFormat` 계열), `title`(+접근성 라벨)에 전체 ISO.
  - CSS: `.ticker-bar`를 `display: flex`로 — 트랙 래퍼가 `flex: 1; overflow: hidden`, 칩은 `flex: none`.
  - `asOf` 없음(파싱 불가 포함) → 칩 미렌더, 티커는 지표만으로 동작.
- 기존 `AsOfBadge`(60초+ stale일 때만 뜨는 이상 알림)는 역할이 다르므로 그대로 둔다 — 이 칩은
  "정상 상태의 기준 시각"을 상시로 보여주는 별개 요소다.

### 엣지 케이스
- 지표 로딩 중/실패: 빈 배열 → 티커 미렌더 → 헤더만 sticky (레이아웃은 흐름 배치라 점프 없이 자연 확장).
- 모션 최소화 설정 사용자: 기존 media query가 애니메이션을 멈춤 — 상단 이동과 무관하게 유지.

## 2. 전체 모바일 검증

- **매트릭스**: 뷰포트 390×844 + 브레이크포인트 경계(560px, 900px) / 3페이지 — 대시보드,
  종목 상세(US 1종목 + KR 1종목), 기사 분석 / 다크·라이트 테마.
- **방법**: 로컬 실행(`make run` — 빌드된 SPA를 :8000에서 서빙) 후 Playwright 브라우저로
  뷰포트별 검증 + 스크린샷. 발견된 문제는 이번 작업 범위에서 수정한다.
- **수용 기준**:
  1. 어떤 페이지에서도 body 수평 스크롤이 생기지 않는다.
  2. 차트(PriceChart)·주식 테이블·호가창(OrderBook)이 모바일 폭에서 렌더되고 조작 가능하다
     (테이블류는 자체 컨테이너 안 가로 스크롤 허용).
  3. 상단 티커가 sticky로 동작하고 콘텐츠를 가리지 않는다.
  4. 네비게이션 링크·테마 토글이 겹침 없이 탭 가능하다.
- 배포 후 실기기 확인은 사용자가 CloudFront URL로 수행.

## 3. 테스트

- `App.test.tsx`: `.app-top` 래퍼 안에 헤더 → 티커 순서로 렌더되고 main이 래퍼 밖 형제인 DOM
  구조 어서션 추가/갱신.
- `TickerBar.test.tsx`: 시각 칩 추가분 — `asOf` 있음(HH:MM 렌더 + title에 ISO) / 없음(칩 미렌더) /
  파싱 불가(칩 미렌더) 케이스. 기존 지표 렌더 테스트는 그대로 통과해야 함.
- 기존 프론트 110개(변경 후 개수 증감 가능) + 백엔드 295개 회귀 그린 유지.

## 범위 제외 (YAGNI)

- 지표 추가/변경 (이미 TUI와 동일한 11개), 백엔드 API·캐시 변경, 지표 상세 화면,
  모바일 전용 내비게이션(햄버거 등) 신설 — 검증에서 치명 문제가 나오면 별도 결정으로 승격.
