/**
 * 앱 셸 레이아웃 — 상단 네비 / 페이지(Outlet) / 하단 티커 바.
 * The app shell layout: top nav, the page via Outlet, the bottom ticker.
 *
 * 라우트 테이블은 `main.tsx`에 있다 (RouterProvider 옆). 이 파일은 컴포넌트만 export해야 하며
 * (oxlint `react/only-export-components` — HMR 보존), 그래서 라우트 정의를 여기 두지 않는다.
 * The route table lives in `main.tsx`, next to RouterProvider: this file must export components only
 * (oxlint's `react/only-export-components`, which preserves HMR), so the routes are not defined here.
 */
import { Link, NavLink, Outlet, useRouteError } from 'react-router-dom'

import { useOverview } from './api/queries.ts'
import { Card } from './components/common/Card.tsx'
import { ThemeToggle } from './components/common/ThemeToggle.tsx'
import { TickerBar } from './components/common/TickerBar.tsx'

export default function App() {
  /*
   * 티커 바 데이터는 셸에서 한 번만 가져온다 — 대시보드가 쓰는 `useOverview()`와 같은 쿼리 키라
   * 요청은 공유되고, 로딩/실패 중에는 빈 배열이 내려가 티커 바가 스스로 사라진다 (앱은 계속 뜬다).
   * The shell fetches the ticker data once; it shares the query key (and therefore the request) with
   * the dashboard's `useOverview()`, and while loading or after a failure an empty array goes down and
   * the ticker removes itself — the app still renders.
   */
  const { data } = useOverview()

  return (
    <div className="app">
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

      <main className="app-main">
        <Outlet />
      </main>

      <TickerBar indicators={data?.indicators ?? []} />
    </div>
  )
}

/**
 * 매칭되는 라우트가 없을 때 (`main.tsx`의 `*` 자식 라우트) / No route matched (`main.tsx`'s `*` child route).
 *
 * react-router의 기본 no-match 화면("Unexpected Application Error"…)을 사용자에게 보이지 않는 것이 목적이다.
 * 셸의 **자식**으로 두었으므로 네비·티커 바는 그대로 살아 있고 페이지 영역만 안내로 바뀐다 — 즉 죽은 링크
 * 하나가 앱 전체를 내려앉히지 않는다 (스펙 7).
 * The point is that react-router's default no-match screen ("Unexpected Application Error"…) never reaches a
 * user. Sitting as a **child** of the shell, it leaves the nav and ticker alive and swaps only the page area,
 * so one dead link never brings the app down (spec 7).
 */
export function NotFound() {
  return (
    <Card title="페이지를 찾을 수 없습니다">
      <p className="empty">요청한 주소에 해당하는 화면이 없습니다.</p>
      <p className="notice-back">
        <Link to="/">대시보드로 이동</Link>
      </p>
    </Card>
  )
}

/**
 * 셸 레벨 에러 경계 (`main.tsx`의 `errorElement`) — 스펙 7 "ErrorBoundary로 전체 붕괴 방지".
 * The shell-level error boundary (`main.tsx`'s `errorElement`); spec 7's "an ErrorBoundary prevents total
 * collapse".
 *
 * 렌더 중 예외나 lazy 라우트 로딩 실패가 여기로 올라온다. 기본 화면은 스택 트레이스를 그대로 보여주므로
 * 대신 안내 + 홈 링크 + 새로고침을 준다. **오류 메시지는 감추지 않는다**(조용한 실패 금지) — 다만 문구를
 * 앞세우고 원문은 보조 정보로 둔다.
 * A render-time exception or a failed lazy route arrives here. The default screen would print a stack trace, so
 * this offers wording, a link home and a reload instead. **The message is not hidden** (no silent failures); it
 * simply sits behind the human-readable line.
 */
export function RouteError() {
  const error = useRouteError()
  const detail =
    error instanceof Error ? error.message : typeof error === 'string' ? error : null

  return (
    <div className="app">
      <header className="app-nav">
        <Link className="app-brand" to="/">
          stock-monitoring
        </Link>
      </header>
      <main className="app-main">
        <Card title="화면을 표시할 수 없습니다">
          <p className="empty">
            예기치 않은 오류가 발생했습니다. 새로고침해도 계속되면 대시보드로 돌아가 주세요.
          </p>
          {detail !== null && <p className="empty">{detail}</p>}
          <p className="notice-back">
            <Link to="/">대시보드로 이동</Link>
          </p>
        </Card>
      </main>
    </div>
  )
}
