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
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  const table = (activeScope: QuoteScope) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<StockTable scope={activeScope} onScopeChange={onScopeChange} />} />
          <Route path="/stocks/:symbol" element={<StockDetailStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(table(scope))
  const bodyRows = () => Array.from(view.container.querySelectorAll('tbody tr'))
  return { ...view, queryClient, bodyRows, rerenderScope: (next: QuoteScope) => view.rerender(table(next)) }
}

/** 헤더 버튼 클릭 = 정렬 토글 / Clicking a header button toggles the sort */
function sortBy(label: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }))
}

beforeEach(() => {
  localStorage.clear()
  window.dispatchEvent(new StorageEvent('storage', { key: null }))
  watchlistStore.reload()
  vi.mocked(useQuotes).mockReturnValue(hookResult({ data: [SAMSUNG, HYNIX] }))
  vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [], isLoading: false, error: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
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

  it('시가총액 결측은 양방향 모두 마지막이다 / missing market caps stay last in both directions', () => {
    const { bodyRows } = renderTable()

    expect(screen.getByText('—')).toBeTruthy()

    sortBy('시가총액')
    expect(bodyRows().map((row) => row.textContent)).toHaveLength(2)
    expect(bodyRows()[0]!.textContent).toContain('Samsung Electronics')

    sortBy('시가총액')
    expect(bodyRows()[0]!.textContent).toContain('Samsung Electronics')
    expect(bodyRows()[1]!.textContent).toContain('SK Hynix')
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

  it.each(['삼성전자', 'ㅅㅅㅈㅈ', 'samSung', '005930'])(
    '종목 검색은 한글·초성·영문·코드를 지원한다 / searches names and symbols: %s',
    (query) => {
      vi.mocked(useQuotes).mockReturnValue(hookResult({
        data: [{ ...SAMSUNG, name_ko: '삼성전자' }, { ...HYNIX, name_ko: '에스케이하이닉스' }],
      }))
      const { bodyRows } = renderTable()

      fireEvent.change(screen.getByRole('searchbox', { name: '종목 검색' }), { target: { value: query } })

      expect(bodyRows()).toHaveLength(1)
      expect(within(bodyRows()[0]! as HTMLElement).getByRole('link', { name: SAMSUNG.symbol })).toBeTruthy()
      expect(screen.getByRole('status').textContent).toMatch(/1\s*\/\s*2/)
    },
  )

  it('검색·섹터·등락을 함께 적용한다 / combines search, sector and movement filters', () => {
    const declining = { ...HYNIX, name: 'Samsung Electro-Mechanics', name_ko: '삼성전기' }
    const healthcare = { ...AAPL, name: 'Samsung Biologics', name_ko: '삼성바이오로직스', sector: 'Healthcare' }
    vi.mocked(useQuotes).mockReturnValue(hookResult({
      data: [{ ...SAMSUNG, name_ko: '삼성전자' }, declining, healthcare],
    }))
    const { bodyRows } = renderTable()

    fireEvent.change(screen.getByRole('searchbox', { name: '종목 검색' }), { target: { value: 'ㅅㅅ' } })
    fireEvent.change(screen.getByRole('combobox', { name: '섹터' }), { target: { value: 'Semiconductor' } })
    const movement = screen.getByRole('group', { name: '등락 필터' })
    fireEvent.click(within(movement).getByRole('button', { name: '하락' }))

    expect(bodyRows()).toHaveLength(1)
    expect(bodyRows()[0]!.textContent).toContain('삼성전기')
    expect(within(movement).getByRole('button', { name: '하락' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('status').textContent).toMatch(/1\s*\/\s*3/)

    fireEvent.click(within(movement).getByRole('button', { name: '상승' }))
    expect(bodyRows()).toHaveLength(1)
    expect(bodyRows()[0]!.textContent).toContain('삼성전자')
  })

  it('보합은 정확히 0인 종목만 고른다 / flat selects exactly zero changes', () => {
    vi.mocked(useQuotes).mockReturnValue(hookResult({
      data: [SAMSUNG, HYNIX, { ...AAPL, change: 0, change_pct: 0 }],
    }))
    const { bodyRows } = renderTable()
    const movement = screen.getByRole('group', { name: '등락 필터' })

    fireEvent.click(within(movement).getByRole('button', { name: '보합' }))
    expect(bodyRows()).toHaveLength(1)
    expect(bodyRows()[0]!.textContent).toContain('AAPL')

    fireEvent.click(within(movement).getByRole('button', { name: '전체' }))
    expect(bodyRows()).toHaveLength(3)
  })

  it('검색 결과는 8건을 넘어도 원래 순서로 모두 보인다 / search is unlimited and keeps source order', () => {
    const quotes = Array.from({ length: 12 }, (_, index) => ({
      ...AAPL,
      symbol: `S${String(12 - index).padStart(2, '0')}`,
      name: `Apple supplier ${index}`,
    }))
    vi.mocked(useQuotes).mockReturnValue(hookResult({ data: quotes }))
    const { bodyRows } = renderTable('us')

    fireEvent.change(screen.getByRole('searchbox', { name: '종목 검색' }), { target: { value: 'apple' } })

    expect(bodyRows().map((row) => row.querySelector('.cell-symbol')?.textContent)).toEqual([
      'S12', 'S11', 'S10', 'S09', 'S08', 'S07', 'S06', 'S05', 'S04', 'S03', 'S02', 'S01',
    ])
    expect(screen.getByRole('status').textContent).toMatch(/12\s*\/\s*12/)
  })

  it('결과가 없으면 초기화로 필터·정렬을 지우고 검색에 포커스를 돌린다 / reset restores the source view after no matches', () => {
    const { bodyRows } = renderTable()
    sortBy('현재가')
    fireEvent.change(screen.getByRole('combobox', { name: '섹터' }), { target: { value: 'Semiconductor' } })
    fireEvent.click(within(screen.getByRole('group', { name: '등락 필터' })).getByRole('button', { name: '하락' }))
    const search = screen.getByRole('searchbox', { name: '종목 검색' }) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'no such company' } })

    expect(bodyRows()).toHaveLength(0)
    expect(screen.getByText(/조건에 맞는 종목이 없습니다/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/0\s*\/\s*2/)
    expect((screen.getByRole('button', { name: 'CSV 내보내기' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '시세 보기 초기화' }))

    expect(search.value).toBe('')
    expect(document.activeElement).toBe(search)
    expect((screen.getByRole('combobox', { name: '섹터' }) as HTMLSelectElement).value).toBe('')
    expect(within(screen.getByRole('group', { name: '등락 필터' })).getByRole('button', { name: '전체' }).getAttribute('aria-pressed')).toBe('true')
    expect(bodyRows().map((row) => row.querySelector('.cell-symbol')?.textContent)).toEqual(['005930.KS', '000660.KS'])
    expect(screen.getAllByRole('columnheader').every((header) => header.getAttribute('aria-sort') !== 'descending')).toBe(true)
  })

  it('한글명과 통화를 보여 주며 기본 시장 컨트롤은 중복하지 않는다 / shows Korean names and currency without duplicate scope controls', () => {
    vi.mocked(useQuotes).mockReturnValue(hookResult({ data: [{ ...SAMSUNG, name_ko: '삼성전자' }, AAPL] }))
    const { bodyRows } = renderTable()

    expect(screen.getByText('삼성전자')).toBeTruthy()
    expect(bodyRows()[0]!.textContent).toContain('KRW')
    expect(bodyRows()[1]!.textContent).toContain('USD')
    expect(screen.queryByRole('group', { name: '시장 선택' })).toBeNull()
  })

  it('정렬은 캐시 배열을 변경하지 않는다 / sorting does not mutate cached quotes', () => {
    const quotes = Object.freeze([Object.freeze(SAMSUNG), Object.freeze(HYNIX)]) as unknown as Quote[]
    vi.mocked(useQuotes).mockReturnValue(hookResult({ data: quotes }))
    const { bodyRows } = renderTable()

    sortBy('현재가')

    expect(bodyRows()[0]!.textContent).toContain('000660.KS')
    expect(quotes.map((quote) => quote.symbol)).toEqual(['005930.KS', '000660.KS'])
  })

  it.each(['Enter', ' '])('행은 키보드로 열 수 있다 / opens a focused row with %s', (key) => {
    const { bodyRows } = renderTable()
    fireEvent.keyDown(bodyRows()[0]!, { key })
    expect(screen.getByText('상세 005930.KS')).toBeTruthy()
  })

  it.each(['Enter', ' '])('별의 키 입력은 행 이동을 일으키지 않는다 / star %s stays separate from row navigation', (key) => {
    renderTable()
    const star = screen.getByRole('button', { name: '005930.KS 관심 추가' })

    expect(fireEvent.keyDown(star, { key })).toBe(true)
    expect(screen.queryByText(/^상세 /)).toBeNull()
    fireEvent.click(star)

    expect(watchlistStore.get()).toEqual(['005930.KS'])
    expect(screen.queryByText(/^상세 /)).toBeNull()
  })

  it('심볼은 기본 링크로 상세를 연다 / the symbol is a native detail link', () => {
    renderTable()
    const link = screen.getByRole('link', { name: SAMSUNG.symbol })
    expect(link.getAttribute('href')).toBe('/stocks/005930.KS')
    // 링크의 키 기본 동작을 행 핸들러가 가로채지 않는다 / The row must not consume the link's native key handling.
    expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true)
    expect(screen.queryByText(/^상세 /)).toBeNull()

    fireEvent.click(link)
    expect(screen.getByText('상세 005930.KS')).toBeTruthy()
  })

  it.each([null, '삼성전자'])(
    '종목명도 기본 링크로 상세·새 탭을 지원한다 / company names provide native detail links: %s',
    (nameKo) => {
      vi.mocked(useQuotes).mockReturnValue(hookResult({ data: [{ ...SAMSUNG, name_ko: nameKo }] }))
      renderTable()
      const name = nameKo ?? SAMSUNG.name
      const link = within(screen.getByRole('cell', { name })).getByRole('link', { name })
      expect(link.getAttribute('href')).toBe('/stocks/005930.KS')
      expect(fireEvent.keyDown(link, { key: 'Enter' })).toBe(true)
      expect(screen.queryByText(/^상세 /)).toBeNull()

      let preventedByComponent: boolean | undefined
      const stopBrowserNavigation = (event: MouseEvent) => {
        preventedByComponent = event.defaultPrevented
        event.preventDefault()
      }
      document.addEventListener('click', stopBrowserNavigation)
      try {
        fireEvent.click(link, { metaKey: true })
      } finally {
        document.removeEventListener('click', stopBrowserNavigation)
      }
      expect(preventedByComponent).toBe(false)
      expect(screen.queryByText(/^상세 /)).toBeNull()

      fireEvent.click(link)
      expect(screen.getByText('상세 005930.KS')).toBeTruthy()
    },
  )

  it.each(['ctrlKey', 'metaKey', 'shiftKey', 'altKey'])(
    '심볼 링크의 새 탭·수정 클릭을 보존한다 / preserves modified link clicks: %s',
    (modifier) => {
      renderTable()
      const link = screen.getByRole('link', { name: SAMSUNG.symbol })
      let preventedByComponent: boolean | undefined
      const stopBrowserNavigation = (event: MouseEvent) => {
        preventedByComponent = event.defaultPrevented
        event.preventDefault()
      }
      document.addEventListener('click', stopBrowserNavigation)
      try {
        fireEvent.click(link, { [modifier]: true })
      } finally {
        document.removeEventListener('click', stopBrowserNavigation)
      }

      expect(preventedByComponent).toBe(false)
      expect(screen.queryByText(/^상세 /)).toBeNull()
    },
  )

  it('백그라운드 오류는 기존 행과 필터를 남기고 재시도를 노출한다 / a refresh error retains usable quotes with a visible retry', () => {
    vi.mocked(useQuotes).mockReturnValue(hookResult({
      data: [SAMSUNG, HYNIX],
      error: new Error('private upstream detail'),
    }))
    const { bodyRows, queryClient } = renderTable()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    expect(bodyRows()).toHaveLength(2)
    const notice = screen.getByRole('status', { name: '데이터 갱신 안내' })
    expect(notice.textContent).toMatch(/갱신|새로|업데이트/)
    expect(notice.textContent).not.toContain('private upstream detail')
    fireEvent.change(screen.getByRole('searchbox', { name: '종목 검색' }), { target: { value: '005930' } })
    expect(bodyRows()).toHaveLength(1)

    fireEvent.click(within(notice).getByRole('button', { name: '다시 시도' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['quotes', 'kr'] })
  })

  it('처음 실패해도 패널 제목과 시장 전환을 남긴다 / an initial failure keeps the panel header and market switching', () => {
    vi.mocked(useQuotes).mockReturnValue(hookResult({ error: new Error('boom') }))
    const onScopeChange = vi.fn()
    renderTable('kr', onScopeChange)

    expect(screen.getByRole('heading', { name: '한국 시세' })).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '미국' }))
    expect(onScopeChange).toHaveBeenCalledWith('us')
    expect((screen.getByRole('button', { name: 'CSV 내보내기' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('표 밀도를 저장하고 재마운트와 보기 초기화 뒤에도 기억한다 / density survives remounts and view reset', () => {
    const first = renderTable()
    fireEvent.click(within(screen.getByRole('group', { name: '표 밀도' })).getByRole('button', { name: '촘촘하게' }))
    expect(screen.getByRole('table').classList.contains('quote-table--compact')).toBe(true)
    expect(JSON.parse(localStorage.getItem('stock-monitoring:quote-density') ?? 'null')).toBe('compact')
    first.unmount()

    renderTable()
    expect(screen.getByRole('table').classList.contains('quote-table--compact')).toBe(true)
    fireEvent.change(screen.getByRole('searchbox', { name: '종목 검색' }), { target: { value: 'samsung' } })
    fireEvent.click(screen.getByRole('button', { name: '시세 보기 초기화' }))
    expect(screen.getByRole('table').classList.contains('quote-table--compact')).toBe(true)
    fireEvent.click(within(screen.getByRole('group', { name: '표 밀도' })).getByRole('button', { name: '여유롭게' }))
    expect(screen.getByRole('table').classList.contains('quote-table--comfortable')).toBe(true)
  })

  it('시장 전환은 이전 필터를 지우되 표 밀도는 유지한다 / changing market resets the view but preserves density', () => {
    const { bodyRows, rerenderScope } = renderTable()
    fireEvent.change(screen.getByRole('searchbox', { name: '종목 검색' }), { target: { value: 'Samsung' } })
    fireEvent.change(screen.getByRole('combobox', { name: '섹터' }), { target: { value: 'Semiconductor' } })
    sortBy('현재가')
    fireEvent.click(within(screen.getByRole('group', { name: '표 밀도' })).getByRole('button', { name: '촘촘하게' }))
    vi.mocked(useQuotes).mockReturnValue(hookResult({ data: [AAPL] }))

    rerenderScope('us')

    expect((screen.getByRole('searchbox', { name: '종목 검색' }) as HTMLInputElement).value).toBe('')
    expect((screen.getByRole('combobox', { name: '섹터' }) as HTMLSelectElement).value).toBe('')
    expect(bodyRows()).toHaveLength(1)
    expect(bodyRows()[0]!.textContent).toContain('AAPL')
    expect(screen.getByRole('table').classList.contains('quote-table--compact')).toBe(true)
    expect(screen.getAllByRole('columnheader').every((header) => header.getAttribute('aria-sort') !== 'descending')).toBe(true)
  })

  it('시세 갱신으로 선택 섹터가 사라져도 필터 상태를 숨기지 않는다 / keeps a selected sector visible when refreshed quotes no longer contain it', () => {
    vi.mocked(useQuotes).mockReturnValue(hookResult({ data: [SAMSUNG, AAPL] }))
    const { bodyRows, rerenderScope } = renderTable()
    fireEvent.change(screen.getByRole('combobox', { name: '섹터' }), { target: { value: 'Semiconductor' } })
    vi.mocked(useQuotes).mockReturnValue(hookResult({ data: [AAPL] }))

    rerenderScope('kr')

    const sector = screen.getByRole('combobox', { name: '섹터' }) as HTMLSelectElement
    expect(sector.selectedOptions[0]?.textContent).toContain('Semiconductor')
    expect(bodyRows()).toHaveLength(0)
    expect(screen.getByText(/조건에 맞는 종목이 없습니다/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '시세 보기 초기화' }))
    expect(bodyRows()).toHaveLength(1)
    expect(sector.value).toBe('')
  })

  it('CSV는 화면에 남은 정렬 순서와 원본 숫자·통화를 내보낸다 / downloads the displayed order with original numbers and currency', async () => {
    const blobs: Blob[] = []
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(blob: Blob) {
        blobs.push(blob)
        return 'blob:quote-export'
      }
      static revokeObjectURL = vi.fn()
    })
    const downloads: { filename: string; href: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ filename: this.download, href: this.href })
    })
    vi.mocked(useQuotes).mockReturnValue(hookResult({
      data: [
        { ...AAPL, price: 245.56789, change: -2.1234, change_pct: -0.86432, sector: 'Semiconductor' },
        { ...SAMSUNG, name_ko: '삼성전자' },
        { ...HYNIX, sector: 'Other' },
      ],
    }))
    renderTable()
    fireEvent.change(screen.getByRole('combobox', { name: '섹터' }), { target: { value: 'Semiconductor' } })
    sortBy('현재가')
    fireEvent.click(screen.getByRole('button', { name: 'CSV 내보내기' }))

    expect(downloads).toEqual([{ filename: 'quotes-kr.csv', href: 'blob:quote-export' }])
    expect(blobs).toHaveLength(1)
    expect(blobs[0]!.type).toBe('text/csv;charset=utf-8')
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blobs[0]!)
    })
    expect(Array.from(new Uint8Array(bytes).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const lines = new TextDecoder().decode(bytes).trimEnd().split('\r\n')
    expect(lines).toEqual([
      'symbol,name,name_ko,market,sector,currency,price,change,change_pct,market_cap,volume',
      '005930.KS,Samsung Electronics,삼성전자,kr,Semiconductor,KRW,262500,55500,26.81,1723722815325000,58478873',
      'AAPL,Apple,,us,Semiconductor,USD,245.56789,-2.1234,-0.86432,3700000000000,41234567',
    ])
  })
})
