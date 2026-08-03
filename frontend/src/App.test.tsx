/**
 * 앱 셸 배선 테스트 — 네비 / Outlet / 티커 바가 실제로 붙어 있는지 확인한다.
 * App shell wiring test; it checks that the nav, the Outlet and the ticker bar are really connected.
 *
 * 라우터는 main.tsx의 `createBrowserRouter`가 소유하므로 여기서는 같은 모양(레이아웃 + 자식 라우트)을
 * 메모리 라우터로 재현한다. 뒤쪽 두 케이스(no-match / 에러 경계)는 `errorElement`가 데이터 라우터에서만
 * 동작하므로 `createMemoryRouter`를 쓴다 — 셸이 이 파일에서 함께 export하는 `NotFound`/`RouteError`가
 * 대상이다.
 * main.tsx's `createBrowserRouter` owns the real router, so this reproduces the same shape (layout plus a child
 * route) with a memory router. The last two cases (no-match and the error boundary) use `createMemoryRouter`,
 * since `errorElement` only works on a data router; their subjects are `NotFound`/`RouteError`, which the shell
 * file exports alongside `App`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  Routes,
  RouterProvider,
} from 'react-router-dom'

import App, { NotFound, RouteError } from './App.tsx'

const OVERVIEW_ENVELOPE = {
  asOf: '2026-08-02T09:00:00+00:00',
  marketOpen: true,
  data: {
    indices: [],
    indicators: [
      { symbol: 'CL=F', name: 'WTI Oil', value: 78.5, change: 0.92, change_pct: 1.19, unit: '$' },
    ],
    summary: {},
    sectors: {},
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 개요 요청에 성공 응답을 물린다 / Answer the overview request with a success */
function stubOverview() {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(OVERVIEW_ENVELOPE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  )
}

/** 폴링/재시도 없는 클라이언트 — 테스트가 타이머에 매달리지 않게 한다 / No polling or retries, so no test hangs on a timer */
function testQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
}

function renderShell() {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<p>페이지 자리</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

it('네비와 자식 라우트를 렌더하고 지표를 티커 바로 내려보낸다 / renders the nav and child route, and feeds indicators to the ticker', async () => {
  stubOverview()

  renderShell()

  expect(screen.getByRole('link', { name: '대시보드' }).getAttribute('href')).toBe('/')
  expect(screen.getByRole('link', { name: '기사 분석' }).getAttribute('href')).toBe('/articles')
  expect(screen.getByText('페이지 자리')).toBeTruthy()
  // 개요가 도착하면 티커 바가 나타난다 / The ticker appears once the overview arrives
  expect((await screen.findAllByText('WTI Oil')).length).toBeGreaterThan(0)
})

it('헤더와 티커가 상단 sticky 블록 안에 함께 있고 main은 밖이다 / the nav and ticker share the top sticky block; main sits outside', async () => {
  stubOverview()

  const { container } = renderShell()
  // 개요 도착 후 티커까지 렌더된 상태에서 구조를 본다 / Inspect after the overview lands and the ticker exists.
  // 마키가 목록을 두 벌 렌더하므로 findAll이다 / The marquee renders two copies of the list, hence findAll.
  await screen.findAllByText('WTI Oil', undefined, { timeout: 3000 })

  const top = container.querySelector('.app-top')
  expect(top).not.toBeNull()
  expect(top!.querySelector('.app-nav')).not.toBeNull()
  expect(top!.querySelector('.ticker-bar')).not.toBeNull()
  expect(top!.querySelector('.app-main')).toBeNull()
  expect(container.querySelector('.app > .app-main')).not.toBeNull()
})

it('개요가 실패해도 셸은 살아 있고 티커 바만 사라진다 / the shell survives a failed overview; only the ticker disappears', async () => {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('network down')))
  vi.stubGlobal('fetch', fetchMock)

  const { container } = renderShell()
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalled()
  })

  // 셸은 그대로 뜨고, 티커 바는 아예 렌더되지 않는다 (빈 띠도 남기지 않는다).
  // The shell still renders and the ticker is simply absent — not even an empty strip is left behind.
  expect(screen.getByRole('link', { name: '대시보드' })).toBeTruthy()
  expect(screen.getByText('페이지 자리')).toBeTruthy()
  expect(container.querySelector('.ticker-bar')).toBeNull()
})

/*
 * ── 죽은 링크 / 렌더 예외 (F7이 마감한 F3 유보 항목) ──
 * `errorElement`는 데이터 라우터에서만 동작하므로 (`Routes`가 아니라) `createMemoryRouter`로
 * `main.tsx`와 같은 모양(셸 + errorElement + `*` 자식)을 재현한다. 실제 브라우저 라우터 배선은
 * 육안 확인(`/nope` 직접 진입)이 함께 확인한다.
 * ── Dead links and render-time exceptions, the F3 deferral F7 closes ──
 * `errorElement` only works on a data router, so this reproduces `main.tsx`'s shape (shell plus errorElement
 * plus a `*` child) with `createMemoryRouter` rather than `Routes`. The real browser router's wiring is
 * covered alongside by the visual check (entering `/nope` directly).
 */
function renderDataRouter(path: string, index: ReactElement) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <App />,
        errorElement: <RouteError />,
        children: [
          { index: true, element: index },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

it('없는 주소는 셸 안에서 안내하고 홈 링크를 준다 / an unknown path is explained inside the shell, with a link home', () => {
  stubOverview()

  const { container } = renderDataRouter('/nope', <p>페이지 자리</p>)

  expect(screen.getByText('페이지를 찾을 수 없습니다')).toBeTruthy()
  expect(screen.getByRole('link', { name: '대시보드로 이동' }).getAttribute('href')).toBe('/')
  // 셸은 살아 있다 — 네비로 빠져나갈 수 있다 / The shell survives, so the nav is still an exit
  expect(screen.getByRole('link', { name: '대시보드' })).toBeTruthy()
  expect(container.querySelector('.app-nav')).not.toBeNull()
})

it('페이지가 렌더 중 던지면 에러 경계가 안내로 대체한다 / a page throwing during render is replaced by the error boundary', () => {
  stubOverview()
  /*
   * React는 경계가 잡은 예외도 console.error로 남긴다 — 테스트 출력을 깨끗하게 두려고 이 케이스에서만
   * 막는다 (`afterEach`의 `restoreAllMocks`가 되돌린다).
   * React logs a boundary-caught error to console.error anyway; it is silenced for this case alone to keep the
   * test output clean (`afterEach`'s `restoreAllMocks` puts it back).
   */
  vi.spyOn(console, 'error').mockImplementation(() => {})

  function Boom(): ReactElement {
    throw new Error('렌더 폭발')
  }

  renderDataRouter('/', <Boom />)

  expect(screen.getByText('화면을 표시할 수 없습니다')).toBeTruthy()
  // 오류를 삼키지 않는다 (조용한 실패 금지) / The error is not swallowed (no silent failures)
  expect(screen.getByText('렌더 폭발')).toBeTruthy()
  expect(screen.getByRole('link', { name: '대시보드로 이동' }).getAttribute('href')).toBe('/')
  // react-router 기본 화면은 보이지 않는다 / react-router's default screen never shows
  expect(screen.queryByText(/Unexpected Application Error/)).toBeNull()
})
