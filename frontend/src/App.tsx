/**
 * 앱 셸 레이아웃 — 상단 네비 / 페이지(Outlet) / 하단 티커 바.
 * The app shell layout: top nav, the page via Outlet, the bottom ticker.
 *
 * 라우트 테이블은 `main.tsx`에 있다 (RouterProvider 옆). 이 파일은 컴포넌트만 export해야 하며
 * (oxlint `react/only-export-components` — HMR 보존), 그래서 라우트 정의를 여기 두지 않는다.
 * The route table lives in `main.tsx`, next to RouterProvider: this file must export components only
 * (oxlint's `react/only-export-components`, which preserves HMR), so the routes are not defined here.
 */
import { Link, NavLink, Outlet } from 'react-router-dom'

import { useOverview } from './api/queries.ts'
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
