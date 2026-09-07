/** MacroPanel 테스트 — |등락률| 정렬, 단위 표기, 막대 비율, 분기 / Sorting by |change|, unit notation, bar ratios, branches. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useOverview } from '../../api/queries.ts'
import type { Overview } from '../../api/types.ts'
import { MacroPanel } from './MacroPanel.tsx'

vi.mock('../../api/queries.ts', () => ({ useOverview: vi.fn() }))

const OVERVIEW: Overview = {
  indices: [],
  indicators: [
    { symbol: 'CL=F', name: 'WTI Oil', value: 78.5, change: 0.92, change_pct: 1.19, unit: '$' },
    { symbol: '^TNX', name: 'US 10Y', value: 4.25, change: -0.1, change_pct: -2.3, unit: '%' },
    { symbol: 'KRW=X', name: 'USD/KRW', value: 1351.1, change: 0, change_pct: 0, unit: 'W' },
  ],
  summary: { us: { advancing: 0, declining: 0, top_gainers: [], top_losers: [], volume_leaders: [] }, kr: { advancing: 0, declining: 0, top_gainers: [], top_losers: [], volume_leaders: [] } },
  sectors: { us: [], kr: [] },
}

function hookResult(over: Partial<QueryResult<Overview>>): QueryResult<Overview> {
  return { data: undefined, asOf: undefined, marketOpen: undefined, isLoading: false, error: null, ...over }
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MacroPanel />
    </QueryClientProvider>,
  )
  return { ...view, queryClient, rows: () => Array.from(view.container.querySelectorAll('.macro-row')) }
}

beforeEach(() => {
  vi.mocked(useOverview).mockReturnValue(hookResult({ data: OVERVIEW }))
})

describe('MacroPanel', () => {
  it('|등락률| 내림차순으로 정렬하고 단위를 붙인다 / sorts by |change| descending and attaches units', () => {
    const { rows } = renderPanel()
    expect(rows().map((r) => r.querySelector('.macro-name')?.textContent)).toEqual(['US 10Y', 'WTI Oil', 'USD/KRW'])
    expect(screen.getByText('4.25%')).toBeTruthy()
    expect(screen.getByText('$78.50')).toBeTruthy()
    expect(screen.getByText('1,351.10W')).toBeTruthy()
  })

  it('최대 |등락률| 행의 막대가 100%이고 나머지는 비율이다 / the largest move fills 100% and the rest scale', () => {
    const { rows } = renderPanel()
    // jsdom은 `100.0%`를 `100%`로 정규화하므로 숫자로 비교한다 / jsdom normalises `100.0%` to `100%`, so compare numerically
    const widths = rows().map((r) => Number.parseFloat((r.querySelector('.sector-fill') as HTMLElement).style.width))
    expect(widths[0]).toBe(100)
    expect(widths[1]).toBeCloseTo((1.19 / 2.3) * 100, 0)
    expect(widths[2]).toBe(0)
    expect(screen.getByText('-2.30%').classList.contains('down')).toBe(true)
    expect(screen.getByText('+1.19%').classList.contains('up')).toBe(true)
  })

  it('로딩·실패 분기 / loading and failure', () => {
    vi.mocked(useOverview).mockReturnValue(hookResult({ isLoading: true }))
    const first = renderPanel()
    expect(screen.getByRole('status')).toBeTruthy()
    first.unmount()

    vi.mocked(useOverview).mockReturnValue(hookResult({ error: new Error('boom') }))
    const { queryClient } = renderPanel()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['overview'] })
  })
})
