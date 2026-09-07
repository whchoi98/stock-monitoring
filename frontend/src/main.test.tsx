/**
 * 라우트 테이블 배선 테스트 — `main.tsx`의 실제 `createBrowserRouter`를 그대로 실행한다.
 * Route-table wiring test; it runs `main.tsx`'s real `createBrowserRouter` as-is.
 *
 * `App.test.tsx`는 MemoryRouter로 셸 모양을 재현하므로 진짜 라우트 테이블은 아무 테스트도 지나가지
 * 않는다 (F3 리뷰 지적). 여기서는 `#root`를 만들고 `main.tsx`를 import해 엔트리 전체(QueryClient +
 * createBrowserRouter + lazy index 라우트)를 실행하고, `/`가 대시보드를 렌더하는지 확인한다.
 * `App.test.tsx` reproduces the shell's shape with MemoryRouter, so no test exercised the real route table
 * (raised in the F3 review). This one creates `#root` and imports `main.tsx`, running the whole entry point
 * (QueryClient, createBrowserRouter and the lazy index route), then checks that `/` renders the dashboard.
 */
import { act, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const OVERVIEW = {
  indices: [{ symbol: '^GSPC', name: 'S&P 500', value: 7489.72, change: 52.09, change_pct: 0.7 }],
  indicators: [],
  summary: {
    us: { advancing: 28, declining: 22, top_gainers: [], top_losers: [], volume_leaders: [] },
  },
  sectors: { us: [{ sector: 'Technology', avg_change_pct: 0.6, count: 23 }] },
}

const QUOTES = [
  {
    symbol: 'AAPL',
    name: 'Apple',
    price: 245.5,
    change: 2.1,
    change_pct: 0.86,
    volume: 41234567,
    market: 'us',
    currency: 'USD',
    sector: 'Technology',
    market_cap: 3_700_000_000_000,
  },
]

/** 경로별 envelope — 대시보드가 부르는 세 엔드포인트만 / One envelope per path, for the three the dashboard calls */
function envelopeFor(url: string): unknown {
  if (url.includes('/api/market/quotes')) return QUOTES
  if (url.includes('/api/market/news')) return []
  return OVERVIEW
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('index 라우트가 대시보드를 렌더한다 / the index route renders the dashboard', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            asOf: new Date().toISOString(),
            marketOpen: false,
            data: envelopeFor(String(input)),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ),
  )
  // 엔트리가 찾는 마운트 지점 (index.html의 `<div id="root">`) / The mount point the entry looks for
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)

  // 엔트리는 import 자체가 렌더를 일으킨다 — act로 감싸 React의 갱신을 테스트 안에 묶는다.
  // Importing the entry point is what renders, so act() keeps React's updates inside the test.
  await act(async () => {
    await import('./main.tsx')
  })

  /*
   * 라우터의 첫 내비게이션은 비동기다 (index 라우트의 lazy 모듈을 먼저 받아야 한다) — 그동안
   * RouterProvider는 아무것도 렌더하지 않으므로 첫 단언부터 findBy로 기다린다.
   * The router's first navigation is async (the index route's lazy module has to arrive first) and
   * RouterProvider renders nothing until then, so even the first assertion waits via findBy.
   */
  const navLink = await screen.findByRole('link', { name: '시장' })
  expect(navLink.getAttribute('href')).toBe('/')
  // 지수는 셸의 마켓 스트립에, 시세 표는 시장 워크스페이스에 / Indices in the shell's strip, the quote monitor in the workspace
  expect(await screen.findByText('S&P 500')).toBeTruthy()
  expect(await screen.findByText('시장 요약 · 미국')).toBeTruthy()
  expect(await screen.findByText('미국 시세')).toBeTruthy()
  expect(await screen.findByText('Apple')).toBeTruthy()
})
