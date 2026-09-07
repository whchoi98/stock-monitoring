/**
 * StockTable 테스트 — 시세 표의 렌더·포맷·등락색·정렬·행 이동·로딩/실패 분기, 관심 스코프와 ★ 토글을 고정한다.
 * StockTable tests; they pin rendering, formatting, change colour, sorting, row navigation, the loading/failure branches,
 * the watch scope and the ★ toggle.
 *
 * 시세 훅(`useQuotes`/`useSymbolUniverse`)은 `vi.mock`으로 고정한다 — 이 테스트는 네트워크가 아니라 표를 검증한다.
 * 관심 종목 스토어는 실물(localStorage)이다 — ★가 실제로 저장되는지가 계약이다.
 * The quote hooks are pinned with `vi.mock`: this file tests the table, not the network. The watchlist store is real
 * (localStorage): that ★ really persists is the contract.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useQuotes, useSymbolUniverse } from '../../api/queries.ts'
import type { Quote } from '../../api/types.ts'
import type { QuoteScope } from '../../lib/markets.ts'
import { watchlistStore } from '../../lib/watchlistStore.ts'
import { StockTable } from './StockTable.tsx'

vi.mock('../../api/queries.ts', () => ({ useQuotes: vi.fn(), useSymbolUniverse: vi.fn() }))

/** 상승 종목 — 시총 있음 / A rising quote, with a market cap */
const SAMSUNG: Quote = {
  symbol: '005930.KS',
  name: 'Samsung Electronics',
  price: 262500,
  change: 55500,
  change_pct: 26.81,
  volume: 58478873,
  market: 'kr',
  currency: 'KRW',
  sector: 'Semiconductor',
  market_cap: 1723722815325000,
}

/** 하락 종목 — 시총 결측(스케줄러가 아직 채우지 않음) / A falling quote whose cap is not filled yet */
const HYNIX: Quote = {
  symbol: '000660.KS',
  name: 'SK Hynix',
  price: 1718000,
  change: -1000,
  change_pct: -0.06,
  volume: 10499619,
  market: 'kr',
  currency: 'KRW',
  sector: 'Semiconductor',
  market_cap: null,
}

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

/** 훅 반환값 조립 — 지정하지 않은 필드는 "아직 없음" / Build a hook result; unspecified fields mean "not there yet" */
function hookResult(over: Partial<QueryResult<Quote[]>>): QueryResult<Quote[]> {
  return {
    data: undefined,
    asOf: undefined,
    marketOpen: undefined,
    isLoading: false,
    error: null,
    ...over,
  }
}

function StockDetailStub() {
  const { symbol } = useParams()
  return <p>상세 {symbol}</p>
}

function renderTable(scope: QuoteScope = 'kr', onScopeChange?: (scope: QuoteScope) => void) {
  // 폴링/재시도 없는 클라이언트 — 테스트가 타이머에 매달리지 않게 한다 / No polling or retries here
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<StockTable scope={scope} onScopeChange={onScopeChange} />} />
          <Route path="/stocks/:symbol" element={<StockDetailStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const bodyRows = () => Array.from(view.container.querySelectorAll('tbody tr'))
  return { ...view, queryClient, bodyRows }
}

/** 헤더 버튼 클릭 = 정렬 토글 / Clicking a header button toggles the sort */
function sortBy(label: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }))
}

beforeEach(() => {
  localStorage.clear()
  watchlistStore.reload()
  vi.mocked(useQuotes).mockReturnValue(hookResult({ data: [SAMSUNG, HYNIX] }))
  vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [], isLoading: false, error: null })
})

describe('StockTable', () => {
  it('시세 2건이면 본문 행 2개를 렌더한다 / renders one body row per quote', () => {
    const { bodyRows } = renderTable()

    expect(bodyRows()).toHaveLength(2)
    expect(screen.getByText('Samsung Electronics')).toBeTruthy()
    expect(screen.getByText('SK Hynix')).toBeTruthy()
    expect(vi.mocked(useQuotes)).toHaveBeenCalledWith('kr')
    // 시장 스코프에서는 유니버스를 켜지 않는다 / A market scope never enables the universe
    expect(vi.mocked(useSymbolUniverse)).toHaveBeenCalledWith(false)
  })

  it('KRW 가격은 소수점 없이 천 단위로 표기한다 / formats KRW prices with no decimals', () => {
    renderTable()

    expect(screen.getByText('262,500')).toBeTruthy()
    expect(screen.getByText('1,718,000')).toBeTruthy()
    // 시총·거래량도 포매터 결과 그대로 / Cap and volume come straight from the formatters
    expect(screen.getByText('1724조')).toBeTruthy()
    expect(screen.getByText('58.5M')).toBeTruthy()
  })

  it('상승 행은 up, 하락 행은 down 클래스를 갖는다 / marks the rising row up and the falling row down', () => {
    const { bodyRows } = renderTable()
    const [samsung, hynix] = bodyRows()

    expect(samsung!.classList.contains('up')).toBe(true)
    expect(hynix!.classList.contains('down')).toBe(true)
  })

  it('컬럼 헤더 클릭으로 정렬하고 다시 누르면 뒤집는다 / sorts on a header click and reverses on the next', () => {
    const { bodyRows } = renderTable()

    sortBy('현재가')
    expect(bodyRows()[0]!.textContent).toContain('SK Hynix')

    sortBy('현재가')
    expect(bodyRows()[0]!.textContent).toContain('Samsung Electronics')

    sortBy('종목명')
    expect(bodyRows()[0]!.textContent).toContain('Samsung Electronics')
  })

  it('시가총액이 없는 행도 정렬을 깨지 않는다 / a missing market cap never breaks the sort', () => {
    const { bodyRows } = renderTable()

    expect(screen.getByText('—')).toBeTruthy()

    sortBy('시가총액')
    expect(bodyRows().map((row) => row.textContent)).toHaveLength(2)
    expect(bodyRows()[0]!.textContent).toContain('Samsung Electronics')

    sortBy('시가총액')
    expect(bodyRows()[0]!.textContent).toContain('SK Hynix')
  })

  it('행을 클릭하면 종목 상세로 이동한다 / navigates to the stock detail on a row click', () => {
    const { bodyRows } = renderTable()

    fireEvent.click(bodyRows()[1]!)

    expect(screen.getByText('상세 000660.KS')).toBeTruthy()
  })

  it('★는 관심 종목을 저장하고 행 이동을 일으키지 않는다 / ★ stores the symbol without navigating', () => {
    renderTable()

    fireEvent.click(screen.getByRole('button', { name: '005930.KS 관심 추가' }))

    expect(watchlistStore.get()).toEqual(['005930.KS'])
    expect(screen.queryByText(/^상세 /)).toBeNull()
    const star = screen.getByRole('button', { name: '005930.KS 관심 해제' })
    expect(star.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(star)
    expect(watchlistStore.get()).toEqual([])
  })

  it('관심 스코프는 유니버스에서 저장 순서대로 고른다 / the watch scope picks starred symbols from the universe in stored order', () => {
    watchlistStore.set(['AAPL', '005930.KS'])
    vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [SAMSUNG, HYNIX, AAPL], isLoading: false, error: null })
    const { bodyRows } = renderTable('watch')

    expect(vi.mocked(useSymbolUniverse)).toHaveBeenCalledWith(true)
    expect(bodyRows().map((row) => row.querySelector('.cell-symbol')?.textContent)).toEqual(['AAPL', '005930.KS'])
    expect(screen.getByText('관심 종목')).toBeTruthy()
  })

  it('관심 스코프가 비어 있으면 안내 문구를 낸다 / an empty watch scope explains how to add', () => {
    renderTable('watch')
    expect(screen.getByText('☆를 눌러 관심 종목을 추가하세요')).toBeTruthy()
  })

  it('스코프 토글은 onScopeChange를 부른다 / the scope toggle calls onScopeChange', () => {
    const onScopeChange = vi.fn()
    renderTable('kr', onScopeChange)

    fireEvent.click(screen.getByRole('button', { name: '관심' }))
    expect(onScopeChange).toHaveBeenCalledWith('watch')
    fireEvent.click(screen.getByRole('button', { name: '미국' }))
    expect(onScopeChange).toHaveBeenCalledWith('us')
  })

  it('로딩 중에는 스피너만 보인다 / shows only a spinner while loading', () => {
    vi.mocked(useQuotes).mockReturnValue(hookResult({ isLoading: true }))
    const { bodyRows } = renderTable()

    expect(screen.getByRole('status')).toBeTruthy()
    expect(bodyRows()).toHaveLength(0)
  })

  it('실패하면 에러 카드가 뜨고 재시도가 해당 시세 쿼리를 무효화한다 / fails into an error card whose retry invalidates the market quotes', () => {
    vi.mocked(useQuotes).mockReturnValue(hookResult({ error: new Error('boom') }))
    const { queryClient, bodyRows } = renderTable('us')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(bodyRows()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['quotes', 'us'] })
  })

  it('관심 스코프의 재시도는 두 시장을 모두 무효화한다 / a watch-scope retry invalidates both markets', () => {
    vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [], isLoading: false, error: new Error('boom') })
    const { queryClient } = renderTable('watch')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['quotes', 'us'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['quotes', 'kr'] })
  })
})
