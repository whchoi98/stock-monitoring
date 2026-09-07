/**
 * 앱 셸 배선 테스트 — 커맨드 바 / Outlet / 마켓 스트립 / 상태 바가 실제로 붙어 있는지 확인한다.
 * App shell wiring test; it checks that the command bar, the Outlet, the market strip and the status bar are
 * really connected.
 *
 * 라우터는 main.tsx의 `createBrowserRouter`가 소유하므로 여기서는 같은 모양(레이아웃 + 자식 라우트)을 메모리
 * 라우터로 재현한다. 뒤쪽 두 케이스(no-match / 에러 경계)는 `errorElement`가 데이터 라우터에서만 동작하므로
 * `createMemoryRouter`를 쓴다.
 * main.tsx's `createBrowserRouter` owns the real router, so this reproduces the same shape with a memory router. The
 * last two cases (no-match and the error boundary) use `createMemoryRouter`, since `errorElement` only works on a
 * data router.
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
    indices: [{ symbol: '^GSPC', name: 'S&P 500', value: 6489.72, change: 52.09, change_pct: 0.81 }],
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

it('커맨드 바와 자식 라우트를 렌더하고 지수·지표를 스트립으로 내려보낸다 / renders the command bar and child route, and feeds the strip', async () => {
  stubOverview()

  renderShell()

  expect(screen.getByRole('link', { name: '시장' }).getAttribute('href')).toBe('/')
  expect(screen.getByRole('link', { name: '기사 분석' }).getAttribute('href')).toBe('/articles')
  expect(screen.getByRole('combobox', { name: '종목 검색' })).toBeTruthy()
  expect(screen.getByText('페이지 자리')).toBeTruthy()
  // 개요가 도착하면 스트립이 나타난다 — 지수는 고정 셀, 지표는 크롤 / Once the overview lands the strip appears: indices fixed, indicators crawling
  expect(await screen.findByText('S&P 500')).toBeTruthy()
  expect((await screen.findAllByText('WTI Oil')).length).toBeGreaterThan(0)
  // 상태 바는 장 상태를 envelope에서 읽는다 / The status bar reads the market state off the envelope
  expect(await screen.findByText('장중')).toBeTruthy()
})

it('커맨드 바와 스트립이 상단 sticky 블록 안에 함께 있고 main·상태 바는 밖이다 / the command bar and strip share the top sticky block; main and the status bar sit outside', async () => {
  stubOverview()

  const { container } = renderShell()
  await screen.findByText('S&P 500', undefined, { timeout: 3000 })

  const top = container.querySelector('.term-top')
  expect(top).not.toBeNull()
  expect(top!.querySelector('.topbar')).not.toBeNull()
  expect(top!.querySelector('.market-strip')).not.toBeNull()
  expect(top!.querySelector('.term-main')).toBeNull()
  expect(container.querySelector('.terminal > .term-main')).not.toBeNull()
  expect(container.querySelector('.terminal > .statusbar')).not.toBeNull()
})

it('개요가 실패해도 셸은 살아 있고 스트립만 사라진다 / the shell survives a failed overview; only the strip disappears', async () => {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('network down')))
  vi.stubGlobal('fetch', fetchMock)

  const { container } = renderShell()
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalled()
  })

  // 셸은 그대로 뜨고, 스트립은 아예 렌더되지 않는다 (빈 띠도 남기지 않는다). 장 상태는 "확인 중"이다.
  // The shell still renders and the strip is simply absent — not even an empty strip. The market state reads "확인 중".
  expect(screen.getByRole('link', { name: '시장' })).toBeTruthy()
  expect(screen.getByText('페이지 자리')).toBeTruthy()
  expect(container.querySelector('.market-strip')).toBeNull()
  expect(screen.getByText('확인 중')).toBeTruthy()
})

/*
 * ── 죽은 링크 / 렌더 예외 ──
 * `errorElement`는 데이터 라우터에서만 동작하므로 `createMemoryRouter`로 `main.tsx`와 같은 모양을 재현한다.
 * ── Dead links and render-time exceptions ──
 * `errorElement` only works on a data router, so this reproduces `main.tsx`'s shape with `createMemoryRouter`.
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
  expect(screen.getByRole('link', { name: '시장 화면으로 이동' }).getAttribute('href')).toBe('/')
  // 셸은 살아 있다 — 커맨드 바로 빠져나갈 수 있다 / The shell survives, so the command bar is still an exit
  expect(screen.getByRole('link', { name: '시장' })).toBeTruthy()
  expect(container.querySelector('.topbar')).not.toBeNull()
})

it('페이지가 렌더 중 던지면 에러 경계가 안내로 대체한다 / a page throwing during render is replaced by the error boundary', () => {
  stubOverview()
  // React는 경계가 잡은 예외도 console.error로 남긴다 — 이 케이스에서만 막는다 / React logs boundary-caught errors; silenced here alone
  vi.spyOn(console, 'error').mockImplementation(() => {})

  function Boom(): ReactElement {
    throw new Error('렌더 폭발')
  }

  renderDataRouter('/', <Boom />)

  expect(screen.getByText('화면을 표시할 수 없습니다')).toBeTruthy()
  // 오류를 삼키지 않는다 (조용한 실패 금지) / The error is not swallowed (no silent failures)
  expect(screen.getByText('렌더 폭발')).toBeTruthy()
  expect(screen.getByRole('link', { name: '시장 화면으로 이동' }).getAttribute('href')).toBe('/')
  expect(screen.queryByText(/Unexpected Application Error/)).toBeNull()
})
