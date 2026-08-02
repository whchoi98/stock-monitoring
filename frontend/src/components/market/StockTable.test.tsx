/**
 * StockTable 테스트 — 시세 표의 렌더·포맷·등락색·정렬·행 이동·로딩/실패 분기를 고정한다.
 * StockTable tests; they pin the table's rendering, formatting, change colour, sorting, row
 * navigation and the loading/failure branches.
 *
 * F2 훅(`useQuotes`)은 `vi.mock`으로 고정한다 — 이 테스트는 네트워크가 아니라 표를 검증한다.
 * `QueryClientProvider`는 재시도 버튼이 쓰는 `useQueryClient()` 때문에, `MemoryRouter`는 행 클릭
 * 이동 때문에 필요하다.
 * The F2 hook (`useQuotes`) is pinned with `vi.mock`: this file tests the table, not the network.
 * `QueryClientProvider` is required by the retry button's `useQueryClient()`, and `MemoryRouter` by
 * the row-click navigation.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useQuotes } from '../../api/queries.ts'
import type { Market, Quote } from '../../api/types.ts'
import { StockTable } from './StockTable.tsx'

vi.mock('../../api/queries.ts', () => ({ useQuotes: vi.fn() }))

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

function renderTable(market: Market = 'kr') {
  // 폴링/재시도 없는 클라이언트 — 테스트가 타이머에 매달리지 않게 한다 / No polling or retries here
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<StockTable market={market} />} />
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
  vi.mocked(useQuotes).mockReturnValue(hookResult({ data: [SAMSUNG, HYNIX] }))
})

describe('StockTable', () => {
  it('시세 2건이면 본문 행 2개를 렌더한다 / renders one body row per quote', () => {
    const { bodyRows } = renderTable()

    expect(bodyRows()).toHaveLength(2)
    expect(screen.getByText('Samsung Electronics')).toBeTruthy()
    expect(screen.getByText('SK Hynix')).toBeTruthy()
    expect(vi.mocked(useQuotes)).toHaveBeenCalledWith('kr')
  })

  it('KRW 가격은 소수점 없이 천 단위로 표기한다 / formats KRW prices with no decimals', () => {
    renderTable()

    expect(screen.getByText('262,500')).toBeTruthy()
    expect(screen.getByText('1,718,000')).toBeTruthy()
    // 시총·거래량도 F1 포매터 결과 그대로 / Cap and volume come straight from the F1 formatters
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
})
