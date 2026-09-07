/**
 * Watchlist 테스트 — 현재 종목 강조, 행 클릭 이동, 시장 토글, 로딩/실패 분기를 고정한다.
 * Watchlist tests, pinning the current-symbol highlight, row navigation, the market toggle and the loading/failure
 * branches.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useQuotes } from '../../api/queries.ts'
import type { Quote } from '../../api/types.ts'
import { Watchlist } from './Watchlist.tsx'

vi.mock('../../api/queries.ts', () => ({ useQuotes: vi.fn() }))

const AAPL: Quote = {
  symbol: 'AAPL',
  name: 'Apple',
  price: 245.5,
  change: 2.1,
  change_pct: 0.86,
  volume: 41_234_567,
  market: 'us',
  currency: 'USD',
  sector: 'Technology',
  market_cap: 3_700_000_000_000,
}

const MSFT: Quote = { ...AAPL, symbol: 'MSFT', name: 'Microsoft', price: 499.7, change: -10.4, change_pct: -2.04 }
const FLAT: Quote = { ...AAPL, symbol: 'KO', name: 'Coca-Cola', price: 70, change: 0, change_pct: 0 }

function hookResult(over: Partial<QueryResult<Quote[]>>): QueryResult<Quote[]> {
  return { data: undefined, asOf: undefined, marketOpen: undefined, isLoading: false, error: null, ...over }
}

function Detail() {
  const { symbol } = useParams()
  return <p>상세 {symbol}</p>
}

function renderWatchlist(selected = 'AAPL') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/stocks/${selected}`]}>
        <Routes>
          <Route
            path="/stocks/:symbol"
            element={
              <>
                <Watchlist initialMarket="us" selected={selected} />
                <Detail />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const rows = () => Array.from(view.container.querySelectorAll<HTMLAnchorElement>('a.wl-row'))
  return { ...view, queryClient, rows }
}

beforeEach(() => {
  vi.mocked(useQuotes).mockReturnValue(hookResult({ data: [AAPL, MSFT, FLAT] }))
})

describe('Watchlist', () => {
  it('종목마다 행을 렌더하고 현재 종목을 강조한다 / renders one row per quote and highlights the current symbol', () => {
    const { rows } = renderWatchlist()

    expect(rows()).toHaveLength(3)
    expect(vi.mocked(useQuotes)).toHaveBeenCalledWith('us')
    const [apple, microsoft] = rows()
    expect(apple!.classList.contains('wl-selected')).toBe(true)
    expect(apple!.getAttribute('aria-current')).toBe('page')
    expect(microsoft!.classList.contains('wl-selected')).toBe(false)
    expect(microsoft!.getAttribute('aria-current')).toBeNull()
  })

  it('가격·등락률을 방향색으로 낸다 (보합은 대시) / renders price and change in direction colours, flat as a dash', () => {
    renderWatchlist()

    expect(screen.getByText('245.50')).toBeTruthy()
    expect(screen.getByText('▲+0.86%').classList.contains('up')).toBe(true)
    expect(screen.getByText('▼-2.04%').classList.contains('down')).toBe(true)
    expect(screen.getByText('-').classList.contains('flat')).toBe(true)
  })

  it('행을 누르면 그 종목으로 전환된다 / a row click switches to that symbol', () => {
    const { rows } = renderWatchlist()

    fireEvent.click(rows()[1]!)

    expect(screen.getByText('상세 MSFT')).toBeTruthy()
    expect(rows()[1]!.getAttribute('href')).toBe('/stocks/MSFT')
  })

  it('시장 토글이 다른 시장의 시세를 요청한다 / the market toggle requests the other market', () => {
    renderWatchlist()

    fireEvent.click(screen.getByRole('button', { name: '한국' }))

    expect(vi.mocked(useQuotes)).toHaveBeenLastCalledWith('kr')
    expect(screen.getByRole('button', { name: '한국' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('로딩 중에는 스피너만 보인다 / shows only a spinner while loading', () => {
    vi.mocked(useQuotes).mockReturnValue(hookResult({ isLoading: true }))
    const { rows } = renderWatchlist()

    expect(screen.getByRole('status')).toBeTruthy()
    expect(rows()).toHaveLength(0)
  })

  it('실패하면 토글은 남기고 에러 카드가 뜬다 — 재시도는 그 시장의 시세 키를 무효화한다 / a failure keeps the toggle and shows an error card whose retry invalidates that market’s key', () => {
    vi.mocked(useQuotes).mockReturnValue(hookResult({ error: new Error('boom') }))
    const { queryClient, rows } = renderWatchlist()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(rows()).toHaveLength(0)
    // 한 시장이 실패해도 다른 시장으로 빠져나갈 수 있어야 한다 / The other market must stay reachable when one fails
    expect(screen.getByRole('button', { name: '한국' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['quotes', 'us'] })
  })
})
