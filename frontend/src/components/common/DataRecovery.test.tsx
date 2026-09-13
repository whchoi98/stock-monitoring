/** 실제 QueryClient에 성공 데이터를 넣고 후속 HTTP 실패를 재현한다.
 * Seed real query data, then fail the network refresh: useful data must remain visible.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { Overview, StockDetail } from '../../api/types.ts'
import { MacroPanel } from '../market/MacroPanel.tsx'
import { NewsFeed } from '../market/NewsFeed.tsx'
import { SectorBars } from '../market/SectorBars.tsx'
import { StockHeader } from '../stock/StockHeader.tsx'
import { FundamentalCards } from '../stock/FundamentalCards.tsx'
import { ReturnsRow } from '../stock/ReturnsRow.tsx'
import { StockNews } from '../stock/StockNews.tsx'
import { OrderBook } from '../stock/OrderBook.tsx'
import { InvestorPanel } from '../stock/InvestorPanel.tsx'

const detail: StockDetail = {
  symbol: 'AAPL', name: 'Apple', name_ko: '애플', market: 'us', currency: 'USD',
  price: 200, change: 2, change_pct: 1, open_price: 198, high: 202, low: 197, prev_close: 198,
  volume: 12000, avg_volume: 15000, market_cap: 3e12, week52_high: 250, week52_low: 150,
  day_change: 2, day_change_pct: 1, sector: 'Technology', pe_ratio: 28, eps: 7,
  dividend_yield: 0.5, beta: 1.2, pbr: 30, returns: { '1w': 3.25 }, last_updated: null,
}
const overview: Overview = {
  indices: [], indicators: [{ symbol: 'GC=F', name: 'Gold', value: 2000, change: 10, change_pct: 0.5, unit: '$' }],
  sectors: { us: [{ sector: 'Technology', avg_change_pct: 1, count: 3 }], kr: [] },
  summary: {
    us: { advancing: 3, declining: 0, top_gainers: [], top_losers: [], volume_leaders: [] },
    kr: { advancing: 0, declining: 0, top_gainers: [], top_losers: [], volume_leaders: [] },
  },
}
const news = [{ id: 'story', title: '유지되어야 할 뉴스', link: 'https://example.com/article', source: 'Example', language: 'ko', published: '2026-09-13T00:00:00Z' }]

const cases: { name: string; element: ReactElement; key: readonly string[]; data: unknown; content: string | RegExp }[] = [
  { name: 'macro', element: <MacroPanel />, key: ['overview'], data: overview, content: 'Gold' },
  { name: 'sector', element: <SectorBars market="us" />, key: ['overview'], data: overview, content: 'Technology' },
  { name: 'news', element: <NewsFeed />, key: ['news'], data: news, content: '유지되어야 할 뉴스' },
  { name: 'quote header', element: <StockHeader symbol="AAPL" />, key: ['stock', 'AAPL'], data: detail, content: '200.00' },
  { name: 'fundamentals', element: <FundamentalCards symbol="AAPL" />, key: ['stock', 'AAPL'], data: detail, content: '28.00' },
  { name: 'returns', element: <ReturnsRow symbol="AAPL" />, key: ['stock', 'AAPL'], data: detail, content: /3\.25%/ },
  { name: 'stock news', element: <StockNews symbol="AAPL" />, key: ['stock-news', 'AAPL'], data: news, content: '유지되어야 할 뉴스' },
  { name: 'order book', element: <OrderBook symbol="AAPL" />, key: ['orderbook', 'AAPL'], data: { symbol: 'AAPL', market: 'us', price: 200, simulated: true, entries: [{ price: 201, qty: 10, side: 'ask' }, { price: 199, qty: 10, side: 'bid' }] }, content: '201.00' },
  { name: 'investors', element: <InvestorPanel symbol="AAPL" />, key: ['investors', 'AAPL'], data: { symbol: 'AAPL', market: 'us', simulated: true, rows: [{ date: '2026-09-11', individual: 1, foreign: 2, institution: -3 }] }, content: '2026-09-11' },
]

afterEach(() => vi.unstubAllGlobals())

it.each(cases)('$name retains cached content with an actionable refresh notice', async ({ element, key, data, content }) => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"detail":"unavailable"}', { status: 503 }))))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(key, { asOf: '2026-09-13T00:00:00Z', marketOpen: false, data })
  const view = render(<QueryClientProvider client={client}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>)
  try {
    await screen.findByRole('status', { name: '데이터 갱신 안내' })
    expect(screen.getAllByText(content).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy()
  } finally {
    view.unmount()
    client.clear()
  }
})
