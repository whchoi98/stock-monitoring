/**
 * PriceChart 껍데기 테스트 — 차트가 뜨지 않는 분기만 검증한다.
 * PriceChart shell tests, covering only the branches where no chart is created.
 *
 * lightweight-charts는 canvas를 요구하므로 jsdom에서 렌더될 수 없다. 그래서 캔들이 있는 상태는
 * 여기서 마운트하지 않는다(그 로직은 `chartData.test.ts` + 실제 브라우저 육안 확인이 담당한다).
 * 대신 캔버스가 필요 없는 계약을 고정한다: 기간 탭이 훅에 넘기는 값, 로딩/실패/빈 데이터 분기,
 * 그리고 재시도가 무효화하는 쿼리 키(`api/queries.ts`와 문자열로 중복되므로 테스트가 못을 박아둔다).
 * lightweight-charts needs a canvas and cannot render under jsdom, so a state with candles is never
 * mounted here (`chartData.test.ts` plus the real-browser visual check cover that). What is pinned
 * instead are the contracts that need no canvas: the value the period tabs hand the hook, the loading,
 * failure and empty branches, and the query key the retry invalidates — a string duplicated from
 * `api/queries.ts`, so a test nails it down.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useChart } from '../../api/queries.ts'
import type { ChartData } from '../../api/types.ts'
import { PriceChart } from './PriceChart.tsx'

vi.mock('../../api/queries.ts', () => ({ useChart: vi.fn() }))

/** 캔들이 없는 차트 응답 — 이 상태에서는 차트를 만들지 않으므로 jsdom에서 안전하다 / A candle-less response, safe under jsdom because no chart is built */
const EMPTY_CHART: ChartData = {
  symbol: 'AAPL',
  period: '1m',
  candles: [],
  ma5: [],
  ma20: [],
  signals: [],
}

function hookResult(over: Partial<QueryResult<ChartData>>): QueryResult<ChartData> {
  return {
    data: undefined,
    asOf: undefined,
    marketOpen: undefined,
    isLoading: false,
    error: null,
    ...over,
  }
}

function renderChart(symbol = 'AAPL') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <PriceChart symbol={symbol} />
    </QueryClientProvider>,
  )
  return { ...view, queryClient }
}

beforeEach(() => {
  vi.mocked(useChart).mockReturnValue(hookResult({ data: EMPTY_CHART }))
})

describe('PriceChart', () => {
  it('기간 탭 4개를 1M 선택 상태로 렌더한다 / renders the four period tabs with 1M selected', () => {
    renderChart()

    const tabs = screen.getByRole('group', { name: '기간 선택' })
    expect(Array.from(tabs.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      '1W',
      '1M',
      '3M',
      '1Y',
    ])
    expect(screen.getByRole('button', { name: '1M' }).getAttribute('aria-pressed')).toBe('true')
    expect(vi.mocked(useChart)).toHaveBeenCalledWith('AAPL', '1m')
  })

  it('탭을 누르면 그 기간으로 다시 조회한다 / a tab click refetches that period', () => {
    renderChart()

    fireEvent.click(screen.getByRole('button', { name: '1Y' }))

    expect(vi.mocked(useChart)).toHaveBeenLastCalledWith('AAPL', '1y')
    expect(screen.getByRole('button', { name: '1Y' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '1M' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('로딩 중에는 스피너만 보인다 / shows only a spinner while loading', () => {
    vi.mocked(useChart).mockReturnValue(hookResult({ isLoading: true }))
    const { container } = renderChart()

    expect(screen.getByRole('status')).toBeTruthy()
    expect(container.querySelector('.price-chart')).toBeNull()
  })

  it('캔들이 없으면 빈 상태 문구를 낸다 / states the empty case when there are no candles', () => {
    const { container } = renderChart()

    expect(screen.getByText('차트 데이터가 없습니다')).toBeTruthy()
    expect(container.querySelector('.price-chart')).toBeNull()
  })

  it('실패하면 에러 카드가 뜨고 재시도가 해당 기간의 차트 쿼리를 무효화한다 / fails into an error card whose retry invalidates that period’s chart query', () => {
    vi.mocked(useChart).mockReturnValue(hookResult({ error: new Error('boom') }))
    const { queryClient, container } = renderChart('005930.KS')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(container.querySelector('.price-chart')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chart', '005930.KS', '1m'] })

    // 실패해도 기간 탭은 남는다 — 다른 기간으로 빠져나갈 수 있어야 한다
    // The tabs survive a failure, so another window is still reachable
    fireEvent.click(screen.getByRole('button', { name: '3M' }))
    expect(vi.mocked(useChart)).toHaveBeenLastCalledWith('005930.KS', '3m')
  })
})
