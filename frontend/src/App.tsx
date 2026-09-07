/**
 * 앱 셸 — 터미널 워크스페이스: 상단 sticky 블록(커맨드 바 + 마켓 스트립) / 페이지(Outlet) / 하단 상태 바.
 * The app shell as a terminal workspace: the top sticky block (command bar plus market strip), the page via
 * Outlet, and the bottom status bar.
 *
 * 라우트 테이블은 `main.tsx`에 있다 (RouterProvider 옆). 이 파일은 컴포넌트만 export해야 하며
 * (oxlint `react/only-export-components` — HMR 보존), 그래서 라우트 정의를 여기 두지 않는다.
 * The route table lives in `main.tsx`, next to RouterProvider: this file must export components only
 * (oxlint's `react/only-export-components`, which preserves HMR), so the routes are not defined here.
 */
import { Link, NavLink, Outlet, useRouteError } from 'react-router-dom'

import { useOverview } from './api/queries.ts'
import { MarketStrip } from './components/common/MarketStrip.tsx'
import { Panel } from './components/common/Panel.tsx'
import { StatusBar } from './components/common/StatusBar.tsx'
import { SymbolSearch } from './components/common/SymbolSearch.tsx'
import { ThemeToggle } from './components/common/ThemeToggle.tsx'

function Brand() {
  return (
    <Link className="brand" to="/">
      <span className="brand-mark" aria-hidden="true">
        S
      </span>
      <span className="brand-name">STOCK MONITORING</span>
      <span className="brand-tag">TERMINAL</span>
    </Link>
  )
}

export default function App() {
  /*
   * 스트립·상태 바 데이터는 셸에서 한 번만 가져온다 — 시장 화면이 쓰는 `useOverview()`와 같은 쿼리 키라 요청은
   * 공유되고, 로딩/실패 중에는 빈 배열과 undefined가 내려가 스트립은 스스로 사라지고 상태 바는 "확인 중"이 된다
   * (앱은 계속 뜬다).
   * The shell fetches the strip and status data once; it shares the query key (and therefore the request) with the
   * market screen's `useOverview()`. While loading or after a failure, empty arrays and undefined go down: the strip
   * removes itself and the status bar reads "확인 중" — the app still renders.
   *
   * `asOf`/`marketOpen`은 envelope에서 벗겨진 형제 값이라 `data` 안에 없다 (`queries.ts`의 `unwrap`).
   * `asOf`/`marketOpen` are peeled off the envelope as siblings, so they do not live inside `data`.
   */
  const { data, asOf, marketOpen } = useOverview()

  return (
    <div className="terminal">
      <div className="term-top">
        <header className="topbar">
          <Brand />
          <nav className="topbar-nav" aria-label="주요 화면">
            <NavLink to="/" end>
              시장
            </NavLink>
            <NavLink to="/articles">기사 분석</NavLink>
          </nav>
          <SymbolSearch />
          <div className="topbar-right">
            <ThemeToggle />
          </div>
        </header>
        <MarketStrip
          indices={data?.indices ?? []}
          indicators={data?.indicators ?? []}
          asOf={asOf}
        />
      </div>

      <main className="term-main">
        <Outlet />
      </main>

      <StatusBar marketOpen={marketOpen} asOf={asOf} />
    </div>
  )
}

/**
 * 매칭되는 라우트가 없을 때 (`main.tsx`의 `*` 자식 라우트) / No route matched (`main.tsx`'s `*` child route).
 *
 * react-router의 기본 no-match 화면을 사용자에게 보이지 않는 것이 목적이다. 셸의 **자식**으로 두었으므로 커맨드
 * 바·스트립은 그대로 살아 있고 페이지 영역만 안내로 바뀐다 — 죽은 링크 하나가 앱 전체를 내려앉히지 않는다 (스펙 7).
 * The point is that react-router's default no-match screen never reaches a user. Sitting as a **child** of the
 * shell, it leaves the command bar and strip alive and swaps only the page area (spec 7).
 */
export function NotFound() {
  return (
    <Panel className="notice" eyebrow="404" title="페이지를 찾을 수 없습니다">
      <p className="empty">요청한 주소에 해당하는 화면이 없습니다.</p>
      <p className="notice-back">
        <Link to="/">시장 화면으로 이동</Link>
      </p>
    </Panel>
  )
}

/**
 * 셸 레벨 에러 경계 (`main.tsx`의 `errorElement`) — 스펙 7 "ErrorBoundary로 전체 붕괴 방지".
 * The shell-level error boundary (`main.tsx`'s `errorElement`); spec 7's "an ErrorBoundary prevents total collapse".
 *
 * 렌더 중 예외나 lazy 라우트 로딩 실패가 여기로 올라온다. **오류 메시지는 감추지 않는다**(조용한 실패 금지) —
 * 문구를 앞세우고 원문은 보조 정보로 둔다.
 * A render-time exception or a failed lazy route arrives here. **The message is not hidden** (no silent failures);
 * it simply sits behind the human-readable line.
 */
export function RouteError() {
  const error = useRouteError()
  const detail =
    error instanceof Error ? error.message : typeof error === 'string' ? error : null

  return (
    <div className="terminal">
      <div className="term-top">
        <header className="topbar">
          <Brand />
        </header>
      </div>
      <main className="term-main">
        <Panel className="notice" eyebrow="ERROR" title="화면을 표시할 수 없습니다">
          <p className="empty">
            예기치 않은 오류가 발생했습니다. 새로고침해도 계속되면 시장 화면으로 돌아가 주세요.
          </p>
          {detail !== null && <p className="empty mono">{detail}</p>}
          <p className="notice-back">
            <Link to="/">시장 화면으로 이동</Link>
          </p>
        </Panel>
      </main>
    </div>
  )
}
