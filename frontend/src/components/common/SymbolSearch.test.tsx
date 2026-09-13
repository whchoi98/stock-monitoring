/**
 * SymbolSearch 테스트 — 포커스 전 무요청, 필터·키보드 선택·이동, 전역 단축키를 고정한다.
 * SymbolSearch tests, pinning no request before focus, filtering, keyboard selection and navigation, and the
 * global shortcuts.
 *
 * 유니버스 훅은 모킹한다 — 이 컴포넌트의 계약은 "훅에 enabled를 언제 넘기고, 돌려준 시세를 어떻게 고르게 하는가"다.
 * The universe hook is mocked: the contract here is when `enabled` is handed to the hook and how the returned quotes
 * are offered for selection.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSymbolUniverse } from '../../api/queries.ts'
import type { Quote } from '../../api/types.ts'
import { SymbolSearch } from './SymbolSearch.tsx'

vi.mock('../../api/queries.ts', () => ({ useSymbolUniverse: vi.fn() }))

function quote(symbol: string, name: string, market: Quote['market'] = 'us', name_ko: string | null = null): Quote {
  return {
    symbol,
    name,
    name_ko,
    price: 1,
    change: 0,
    change_pct: 0,
    volume: 0,
    market,
    currency: market === 'kr' ? 'KRW' : 'USD',
    sector: '',
    market_cap: null,
  }
}

const UNIVERSE = [
  quote('AAPL', 'Apple'),
  quote('AMZN', 'Amazon'),
  quote('005930.KS', 'Samsung Electronics', 'kr', '삼성전자'),
]

function Detail() {
  const { symbol } = useParams()
  return <p>상세 {symbol}</p>
}

function renderSearch() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<SymbolSearch />} />
        <Route path="/stocks/:symbol" element={<Detail />} />
      </Routes>
    </MemoryRouter>,
  )
}

const input = () => screen.getByRole('combobox', { name: '종목 검색' }) as HTMLInputElement

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: UNIVERSE, isLoading: false, error: null })
})

describe('SymbolSearch', () => {
  it('포커스 전에는 유니버스를 요청하지 않는다 / never enables the universe before focus', () => {
    renderSearch()
    expect(vi.mocked(useSymbolUniverse)).toHaveBeenLastCalledWith(false)

    fireEvent.focus(input())
    expect(vi.mocked(useSymbolUniverse)).toHaveBeenLastCalledWith(true)
  })

  it('입력하면 순위대로 옵션을 보여주고 첫 옵션이 활성이다 / typing lists ranked options with the first active', () => {
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'a' } })

    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'AAPLAppleUS',
      'AMZNAmazonUS',
      '005930.KS삼성전자 Samsung ElectronicsKR',
    ])
    expect(options[0]!.getAttribute('aria-selected')).toBe('true')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0]!.id)
  })

  it('↓로 내려가고 Enter로 종목 화면에 간다 / ArrowDown moves, Enter opens the stock screen', () => {
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'a' } })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })

    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByText('상세 AMZN')).toBeTruthy()
  })

  it('↑는 맨 위에서 맨 아래로 감싼다 / ArrowUp wraps from the top to the bottom', () => {
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'a' } })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })

    expect(screen.getAllByRole('option')[2]!.getAttribute('aria-selected')).toBe('true')
  })

  it('한글·초성 질의도 찾는다 / Korean and initials queries find the symbol', () => {
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: '삼성' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['005930.KS삼성전자 Samsung ElectronicsKR'])

    fireEvent.change(input(), { target: { value: 'ㅅㅅㅈㅈ' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByText('상세 005930.KS')).toBeTruthy()
  })

  it('옵션 클릭도 이동한다 / clicking an option navigates too', () => {
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: '005930' } })
    fireEvent.click(screen.getByRole('option'))

    expect(screen.getByText('상세 005930.KS')).toBeTruthy()
  })

  it('Esc는 먼저 입력을 지운다 / Escape clears the query first', () => {
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'aap' } })
    fireEvent.keyDown(input(), { key: 'Escape' })

    expect(input().value).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('일치가 없으면 빈 상태 문구, 로딩 중이면 로딩 문구 / empty and loading wording', () => {
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'zzz' } })
    expect(screen.getByRole('status').textContent).toBe('일치하는 종목이 없습니다')

    vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [], isLoading: true, error: null })
    fireEvent.change(input(), { target: { value: 'zzzz' } })
    expect(screen.getByRole('status').textContent).toBe('종목 목록을 불러오는 중…')
  })

  it('⌘K / Ctrl+K / "/"가 입력에 포커스한다 / ⌘K, Ctrl+K and "/" focus the input', () => {
    renderSearch()
    expect(document.activeElement).not.toBe(input())

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(document.activeElement).toBe(input())

    input().blur()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(document.activeElement).toBe(input())

    input().blur()
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(input())
  })

  it('다른 입력에 글을 치는 중에는 "/"를 가로채지 않는다 / "/" is left alone while typing elsewhere', () => {
    renderSearch()
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()

    fireEvent.keyDown(other, { key: '/' })
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('한글 조합 확정 Enter는 이동하지 않고 다음 Enter가 이동한다 / IME confirmation does not navigate', () => {
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: '삼성' } })
    fireEvent.compositionStart(input())
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    expect(screen.queryByText('상세 005930.KS')).toBeNull()
    expect(input().value).toBe('삼성')

    fireEvent.compositionEnd(input())
    // Safari may emit Enter with isComposing=false while its legacy code is still 229.
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 })
    expect(screen.queryByText('상세 005930.KS')).toBeNull()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByText('상세 005930.KS')).toBeTruthy()
  })

  it('조회 실패를 일치 없음으로 표시하지 않는다 / distinguishes failed lookup from no results', () => {
    vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [], isLoading: false, error: new Error('offline') })
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: '삼성' } })
    expect(screen.getByRole('status').textContent).toContain('불러오지 못했습니다')
    expect(screen.queryByText('일치하는 종목이 없습니다')).toBeNull()
  })

  it('미국만 도착하고 한국 요청 중이면 검색 실패로 단정하지 않는다 / waits for a pending market before declaring no matches', () => {
    vi.mocked(useSymbolUniverse).mockReturnValue({
      quotes: [UNIVERSE[0]!], isLoading: false, isFetching: true, error: null,
    })
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: '삼성' } })
    expect(screen.getByRole('status').textContent).toContain('불러오는 중')
    expect(screen.queryByText('일치하는 종목이 없습니다')).toBeNull()

    vi.mocked(useSymbolUniverse).mockReturnValue({
      quotes: UNIVERSE, isLoading: false, isFetching: false, error: null,
    })
    fireEvent.change(input(), { target: { value: '삼성전자' } })
    expect(screen.getByRole('option').textContent).toContain('삼성전자')
  })

  it('한 시장이 실패해도 받은 결과를 선택할 수 있다 / partial results remain selectable with a notice', () => {
    vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: UNIVERSE, isLoading: false, error: new Error('kr failed') })
    renderSearch()
    fireEvent.focus(input())
    fireEvent.change(input(), { target: { value: 'aapl' } })
    expect(screen.getByRole('status').textContent).toContain('일부')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByText('상세 AAPL')).toBeTruthy()
  })
})
