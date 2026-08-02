/**
 * 앱 셸 배선 테스트 — 네비 / Outlet / 티커 바가 실제로 붙어 있는지 확인한다.
 * App shell wiring test; it checks that the nav, the Outlet and the ticker bar are really connected.
 *
 * 라우터는 main.tsx의 `createBrowserRouter`가 소유하므로 여기서는 같은 모양(레이아웃 + 자식 라우트)을
 * MemoryRouter로 재현한다.
 * main.tsx's `createBrowserRouter` owns the real router, so this reproduces the same shape (layout plus
 * a child route) with MemoryRouter.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import App from './App.tsx'

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

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderShell() {
  // 폴링/재시도 없는 클라이언트 — 테스트가 타이머에 매달리지 않게 한다 / No polling or retries, so the test never hangs on a timer
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
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

  renderShell()

  expect(screen.getByRole('link', { name: '대시보드' }).getAttribute('href')).toBe('/')
  expect(screen.getByRole('link', { name: '기사 분석' }).getAttribute('href')).toBe('/articles')
  expect(screen.getByText('페이지 자리')).toBeTruthy()
  // 개요가 도착하면 티커 바가 나타난다 / The ticker appears once the overview arrives
  expect((await screen.findAllByText('WTI Oil')).length).toBeGreaterThan(0)
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
