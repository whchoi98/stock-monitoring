# 경제 지표 상단 sticky 티커 + 모바일 검증 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 하단 무한스크롤 경제지표 티커를 헤더와 한 sticky 블록으로 묶어 상단으로 옮기고, 우측에 업데이트 시각 칩을 상시 표기하며, 앱 전체를 모바일(390px)에서 검증·수정한다.

**Architecture:** 프론트엔드 전용 3태스크 — ① TickerBar에 `asOf` 시각 칩(컴포넌트+CSS 내부 구조), ② App 셸에서 헤더+티커를 `.app-top` sticky 래퍼로 재배치(위치 CSS), ③ Playwright 모바일 검증과 발견 문제 수정. 백엔드 변경 0 (지표 11종·`asOf`는 이미 `GET /api/market/overview` envelope로 서빙 중).

**Tech Stack:** React 19 + TypeScript strict + Vite, vitest + @testing-library/react (colocated), CSS는 `frontend/src/styles/global.css` + `tokens.css` 변수, 검증은 Playwright 브라우저 (뷰포트 에뮬레이션).

**스펙:** `docs/superpowers/specs/2026-08-03-indicators-top-mobile-design.md` (사용자 승인 2026-08-03)

## Global Constraints

- **백엔드 변경 금지** — `backend/` 아래 어떤 파일도 수정하지 않는다.
- TypeScript strict + 함수형 컴포넌트만. 서버 데이터는 기존 `useOverview()` 경유 — 새 fetch/폴링 금지.
- 색상은 `tokens.css` CSS 변수만 (`var(--text)` 등). 하드코딩 색상 금지. 상승=빨강(`--up`)/하락=파랑(`--down`) 불변.
- 주석·테스트 설명은 한국어+영어 병기 (기존 파일 스타일).
- 시각 표기: 브라우저 로컬 시간대 `HH:MM`(24시간) + `기준` 접미, `title`에 `데이터 기준 시각 <ISO 원문>`.
- 기존 마키 애니메이션·`aria-hidden` 사본·`prefers-reduced-motion` 동작은 의미 변화 없이 유지.
- 각 태스크 끝에 `cd frontend && npx vitest run` 전체 그린 확인. 커밋 제목은 Conventional Commits(영어), 본문 한/영 병기. **Co-Authored-By 금지.**
- 검증 뷰포트: 390×844 기본, 브레이크포인트 경계 560px·900px.

---

### Task 1: TickerBar 업데이트 시각 칩 (`asOf`)

**Files:**
- Modify: `frontend/src/components/common/TickerBar.tsx`
- Modify: `frontend/src/App.tsx:46` (prop 한 줄)
- Modify: `frontend/src/styles/global.css` (`.ticker-bar` 내부 구조 + reduced-motion 블록)
- Test: `frontend/src/components/common/TickerBar.test.tsx`

**Interfaces:**
- Consumes: `Overview.asOf: string` (ISO, `frontend/src/api/types.ts:28`), `useOverview()`의 `data?.asOf`.
- Produces: `TickerBarProps`에 `asOf?: string` 추가 (Task 2의 App 재배치에서 그대로 사용). DOM: `.ticker-bar > .ticker-viewport > .ticker-track` + `.ticker-bar > .ticker-clock`(조건부).

- [ ] **Step 1: 실패하는 테스트 작성** — `TickerBar.test.tsx`의 `describe` 안에 추가:

```tsx
it('asOf가 있으면 HH:MM 기준 칩을 렌더한다 / renders the HH:MM clock chip when asOf is given', () => {
  render(<TickerBar indicators={[OIL]} asOf="2026-08-03T05:32:00+00:00" />)
  const clock = screen.getByTitle('데이터 기준 시각 2026-08-03T05:32:00+00:00')
  // 시간대는 실행 환경에 따라 다르므로 형식만 고정한다 / The zone varies by host, so only the shape is pinned.
  expect(clock.textContent).toMatch(/^\d{2}:\d{2} 기준$/)
})

it('asOf가 없으면 칩을 렌더하지 않는다 / renders no chip without asOf', () => {
  render(<TickerBar indicators={[OIL]} />)
  expect(screen.queryByTitle(/데이터 기준 시각/)).toBeNull()
})

it('asOf가 파싱 불가면 칩을 렌더하지 않는다 / renders no chip for an unparseable asOf', () => {
  render(<TickerBar indicators={[OIL]} asOf="not-a-date" />)
  expect(screen.queryByTitle(/데이터 기준 시각/)).toBeNull()
})

it('지표가 없으면 asOf가 있어도 아무것도 렌더하지 않는다 / still renders nothing without indicators', () => {
  const { container } = render(<TickerBar indicators={[]} asOf="2026-08-03T05:32:00+00:00" />)
  expect(container.innerHTML).toBe('')
})
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/components/common/TickerBar.test.tsx`
Expected: 신규 4개 중 첫 번째가 FAIL (`asOf` prop 없음 — TS 컴파일 에러 형태일 수 있음), 기존 4개는 PASS 상태 유지가 목표.

- [ ] **Step 3: 구현** — `TickerBar.tsx`:

```tsx
export interface TickerBarProps {
  /** 경제 지표 — 로딩/실패 중에는 빈 배열이 온다 / The indicators; an empty array while loading or after a failure */
  indicators: Indicator[]
  /**
   * envelope의 `asOf` ISO 문자열 — 우측 시각 칩용. 없거나 파싱 불가면 칩만 빠진다.
   * The envelope's `asOf` ISO string for the right-side clock chip; absent or unparseable drops only the chip.
   */
  asOf?: string
}

/**
 * ISO → 브라우저 로컬 `HH:MM` (24시간). 파싱 불가면 null — 칩을 그리지 않는 신호다.
 * ISO to the browser-local `HH:MM` (24h); null when unparseable, meaning "draw no chip".
 */
function formatClock(iso: string): string | null {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  return new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
}
```

`TickerBar` 본문 교체 (기존 주석 유지):

```tsx
export function TickerBar({ indicators, asOf }: TickerBarProps) {
  if (indicators.length === 0) return null

  const clock = asOf === undefined ? null : formatClock(asOf)

  return (
    <div className="ticker-bar">
      <div className="ticker-viewport">
        <div className="ticker-track">
          <TickerItems indicators={indicators} />
          <div aria-hidden="true">
            <TickerItems indicators={indicators} />
          </div>
        </div>
      </div>
      {clock !== null && (
        <span className="ticker-clock" title={`데이터 기준 시각 ${asOf}`}>
          {clock} 기준
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 4: CSS** — `global.css`의 `.ticker-bar` 블록(1073행 부근)에 `display: flex; align-items: center;` 추가(기존 속성 유지 — 위치 변경은 Task 2), `.ticker-track` 규칙 앞에 신설:

```css
/* 마키가 순환하는 영역 — 우측 시각 칩을 침범하지 않도록 칩과 flex로 나눈다.
   The marquee viewport; flex keeps the crawl out of the right-side clock chip. */
.ticker-viewport {
  flex: 1;
  overflow: hidden;
}

/* 우측 고정 업데이트 시각 칩 / The fixed right-side as-of clock chip */
.ticker-clock {
  flex: none;
  padding: 0 14px;
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  border-left: 1px solid var(--bg);
}
```

reduced-motion 블록(1130행 부근)의 `.ticker-bar { overflow-x: auto; }`를 `.ticker-viewport { overflow-x: auto; }`로 교체 (수동 스크롤 대상이 뷰포트로 이동).

- [ ] **Step 5: App에서 prop 연결** — `App.tsx:46`:

```tsx
<TickerBar indicators={data?.indicators ?? []} asOf={data?.asOf} />
```

- [ ] **Step 6: 전체 테스트 통과 확인**

Run: `cd frontend && npx vitest run`
Expected: 전체 PASS (기존 110 + 신규 4 = 114). `App.test.tsx`의 기존 티커 어서션도 그대로 PASS (DOM 계층이 깊어졌을 뿐 텍스트/클래스 존재는 불변).

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/components/common/TickerBar.tsx frontend/src/components/common/TickerBar.test.tsx frontend/src/App.tsx frontend/src/styles/global.css
git commit -m "feat(frontend): as-of clock chip on the indicator ticker"
```

---

### Task 2: 헤더+티커 상단 sticky 재배치

**Files:**
- Modify: `frontend/src/App.tsx:27-48` (셸 레이아웃)
- Modify: `frontend/src/styles/global.css` (`.app`, `.app-nav`, `.ticker-bar`, 신설 `.app-top`)
- Test: `frontend/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `TickerBar`(`asOf` prop 포함, 변경 없음).
- Produces: DOM 구조 `.app > .app-top(sticky) > [.app-nav, .ticker-bar]` + `.app > .app-main`. Task 3의 sticky 검증이 이 구조를 전제한다.

- [ ] **Step 1: 실패하는 테스트 작성** — `App.test.tsx`에 추가 (기존 86행 테스트와 같은 렌더 헬퍼 사용):

```tsx
it('헤더와 티커가 상단 sticky 블록 안에 함께 있고 main은 밖이다 / the nav and ticker share the top sticky block; main sits outside', async () => {
  const { container } = renderApp()
  // 개요 도착 후 티커까지 렌더된 상태에서 구조를 본다 / Inspect after the overview lands and the ticker exists.
  await screen.findByText('WTI Oil', undefined, { timeout: 3000 })

  const top = container.querySelector('.app-top')
  expect(top).not.toBeNull()
  expect(top!.querySelector('.app-nav')).not.toBeNull()
  expect(top!.querySelector('.ticker-bar')).not.toBeNull()
  expect(top!.querySelector('.app-main')).toBeNull()
  expect(container.querySelector('.app > .app-main')).not.toBeNull()
})
```

(참고: `App.test.tsx`에 `renderApp` 같은 렌더 헬퍼가 이미 있으면 그것을 쓰고, 없으면 기존 86행 테스트가 쓰는 렌더 방식을 그대로 복사한다 — 새 헬퍼를 만들지 않는다.)

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: 신규 테스트 FAIL (`.app-top` 없음), 기존 테스트 PASS.

- [ ] **Step 3: App.tsx 레이아웃 변경** — 셸 반환부를 다음으로 교체 (파일 상단 주석의 "하단 티커 바" 표현도 "상단 sticky 헤더+티커"로 갱신):

```tsx
return (
  <div className="app">
    {/*
      헤더와 티커를 한 sticky 블록으로 묶는다 — 높이 매직 넘버 없이 둘이 함께 상단에 붙는다.
      One sticky block holds the nav and the ticker: both pin to the top with no height constant.
    */}
    <div className="app-top">
      <header className="app-nav">
        <Link className="app-brand" to="/">
          stock-monitoring
        </Link>
        <nav className="app-links">
          <NavLink to="/" end>
            대시보드
          </NavLink>
          <NavLink to="/articles">기사 분석</NavLink>
        </nav>
        <ThemeToggle />
      </header>
      <TickerBar indicators={data?.indicators ?? []} asOf={asOf} />
    </div>

    <main className="app-main">
      <Outlet />
    </main>
  </div>
)
```

(정정 2026-08-03, Task 1에서 컴파일러로 확인: `asOf`는 `Overview`가 아닌 envelope 필드라 `useOverview()`가
`data`의 **형제**로 언랩한다 — Task 1이 이미 `const { data, asOf } = useOverview()`로 바꿔 두었으므로
이 블록은 `asOf={asOf}`가 맞다. 원문 `asOf={data?.asOf}`는 TS2339 컴파일 에러.)

- [ ] **Step 4: CSS 변경** — `global.css`:

1. `.app` (54행 부근): `padding-bottom: 56px;`와 그 위 "하단 고정 티커 바가…" 주석 제거 (`min-height: 100vh;`만 남음).
2. `.app-nav` (60행 부근): `position: sticky; top: 0; z-index: 10;` 세 줄 제거 (flex 이하 유지). 바로 위에 신설:

```css
/* 헤더+티커를 함께 상단에 고정하는 래퍼 — 개별 sticky 대신 한 블록이라 높이 계산이 필요 없다.
   RouteError 셸은 .app-nav를 단독으로 쓰므로 그 헤더는 정적이 된다 (에러 화면 — 무해).
   The wrapper pinning nav+ticker together; one block needs no height math. The RouteError shell
   uses a bare .app-nav, whose header therefore goes static (an error screen — harmless). */
.app-top {
  position: sticky;
  top: 0;
  z-index: 10;
}
```

3. `.ticker-bar` (1073행 부근): `position: fixed; right: 0; bottom: 0; left: 0; z-index: 10;` 제거, `border-top` → `border-bottom`. 파일 상단 근처 티커 주석("하단 고정…")이 있으면 "상단 sticky 블록 내"로 갱신.

- [ ] **Step 5: 전체 테스트 통과 확인**

Run: `cd frontend && npx vitest run`
Expected: 전체 PASS (114 + 신규 1 = 115). 특히 App.test.tsx 98행 "실패 시 티커만 사라진다"가 그대로 PASS — 빈 배열이면 `.app-top` 안에 헤더만 남는다.

- [ ] **Step 6: 수동 스모크 (선택이 아닌 필수, 로컬 1회)**

Run: `make run` 후 브라우저(또는 curl로 HTML만)에서 `http://localhost:8000` — 티커가 헤더 아래 보이고 페이지 하단에 빈 띠가 없는지 육안 확인. 확인 후 서버 종료.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/styles/global.css
git commit -m "feat(frontend): move the indicator ticker into a top sticky block with the nav"
```

---

### Task 3: 전체 모바일 검증 + 발견 문제 수정

**Files:**
- Modify: `frontend/src/styles/global.css` (발견된 문제의 수정 — 미디어 쿼리/레이아웃 한정)
- 스크린샷: 스크래치패드 디렉토리 (커밋하지 않음)

**Interfaces:**
- Consumes: Task 2의 `.app-top` sticky 구조, 배포 전 로컬 빌드(`make run` = `build:deploy` + uvicorn :8000).
- Produces: 스펙 §2 수용 기준 4개 충족 + 수정 커밋(발견분). 구조 변경(컴포넌트 분해·신규 내비 등)이 필요한 문제는 수정하지 말고 BLOCKED로 보고.

- [ ] **Step 1: 로컬 기동**

Run: `make run` (백그라운드). `curl -s http://localhost:8000/api/health`로 기동 확인.

- [ ] **Step 2: Playwright 검증 매트릭스 실행** — 브라우저 뷰포트 390×844로 다음을 순회:
  - 페이지: `/` → `/stocks/AAPL` → `/stocks/005930.KS` → `/articles`
  - 각 페이지에서: ① `browser_evaluate`로 `document.documentElement.scrollWidth`가 뷰포트 폭(390) 이하인지 ② 스크린샷 저장 ③ 500px 세로 스크롤 후 `.app-top`이 화면 상단에 남는지(`getBoundingClientRect().top === 0`) ④ 티커 칩(`.ticker-clock`) 표시 확인
  - 다크(기본) 전체 순회 후, 테마 토글로 라이트 전환해 대시보드 1회 재확인
  - 560px·900px 폭으로 대시보드만 재확인 (브레이크포인트 경계)

- [ ] **Step 3: 발견 문제 기록** — 페이지·뷰포트·증상·원인 CSS 선택자를 표로 정리 (작업 로그용, 커밋 안 함).

- [ ] **Step 4: 문제별 수정 루프** — 각 문제에 대해: `global.css`에서 원인 규칙 수정(기존 브레이크포인트 900px/560px 재사용, 새 브레이크포인트는 꼭 필요할 때만) → 해당 페이지 재스크린샷으로 해소 확인. **수정은 CSS/레이아웃 한정** — 컴포넌트 구조 변경이 필요하면 그 문제는 BLOCKED로 보고하고 다음 문제로.

- [ ] **Step 5: 수용 기준 최종 확인** (스펙 §2 그대로):
  1. 어떤 페이지에서도 body 수평 스크롤 없음 (scrollWidth ≤ 390)
  2. 차트·주식 테이블·호가창 렌더 및 조작 가능 (테이블류는 자체 컨테이너 내 가로 스크롤 허용)
  3. 상단 티커 sticky 동작 + 콘텐츠 미가림
  4. 네비 링크·테마 토글 겹침 없이 탭 가능

- [ ] **Step 6: 회귀 확인**

Run: `cd frontend && npx vitest run` — 전체 PASS. `cd backend && .venv/bin/pytest -q` — 295 PASS (백엔드 무변경 확인용).

- [ ] **Step 7: 커밋** (수정이 있었던 경우만)

```bash
git add frontend/src/styles/global.css
git commit -m "fix(frontend): mobile layout fixes found in the 390px verification pass"
```

수정이 없으면 커밋 없이 "발견 문제 0건, 수용 기준 4/4 충족"을 보고.
