import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { useOverview, useQuotes, useSymbolUniverse } from '../api/queries.ts'
import { watchlistStore } from '../lib/watchlistStore.ts'
import Dashboard from './Dashboard.tsx'

vi.mock('../api/queries.ts', () => ({
  useOverview: vi.fn(), useQuotes: vi.fn(), useSymbolUniverse: vi.fn(),
  useNews: () => ({ data: [], isLoading: false, error: null }),
  QUOTE_POLL_MS: 45000,
}))

function Location() {
  return <output aria-label="현재 주소">{useLocation().search}</output>
}
function show(path: string) {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Dashboard /><Location />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  watchlistStore.reload()
  vi.mocked(useQuotes).mockReturnValue({ data: [], asOf: undefined, marketOpen: false, isLoading: false, error: null })
  vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [], isLoading: false, error: null })
  vi.mocked(useOverview).mockReturnValue({
    data: { indices: [], indicators: [], summary: {} as never, sectors: { us: [], kr: [] } },
    asOf: undefined, marketOpen: false, isLoading: false, error: null,
  })
})

it('URL의 시장을 복원하고 전체 워크스페이스의 선택을 바꾼다 / restores and updates the market in the URL', () => {
  show('/?market=kr')
  expect(screen.getByRole('heading', { level: 1, name: '시장 한눈에' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '한국' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('heading', { name: '한국 시세' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '미국' }))
  expect(screen.getByRole('button', { name: '미국' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByLabelText('현재 주소').textContent).toContain('market=us')
})

it('관심 화면을 열어도 요약의 기준 시장을 URL에 유지한다 / watch keeps its underlying market', () => {
  show('/?market=kr&watch=1')
  expect(screen.getByRole('button', { name: '관심' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('heading', { name: '시장 요약 · 한국' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '한국' }))
  expect(screen.getByLabelText('현재 주소').textContent).toBe('?market=kr')
})
