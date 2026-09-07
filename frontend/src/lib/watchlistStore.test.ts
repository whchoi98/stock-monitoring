/**
 * 관심 종목 스토어 테스트 — 토글·순서·영속·손상 복구 / Watchlist store tests: toggle, order, persistence, corrupt recovery.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { toggleWatch, useWatchlist, WATCHLIST_KEY, watchlistStore } from './watchlistStore.ts'

beforeEach(() => {
  localStorage.clear()
  watchlistStore.reload()
})

describe('watchlistStore', () => {
  it('비어 있는 상태에서 시작한다 / starts empty', () => {
    expect(watchlistStore.get()).toEqual([])
  })

  it('토글은 추가 순서를 지키고 두 번째 토글은 뺀다 / toggling appends in order and a second toggle removes', () => {
    toggleWatch('AAPL')
    toggleWatch('005930.KS')
    expect(watchlistStore.get()).toEqual(['AAPL', '005930.KS'])

    toggleWatch('AAPL')
    expect(watchlistStore.get()).toEqual(['005930.KS'])
    expect(JSON.parse(localStorage.getItem(WATCHLIST_KEY) ?? '[]')).toEqual(['005930.KS'])
  })

  it('저장된 값을 다시 읽는다 / reloads what was stored', () => {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(['MSFT', 'NVDA']))
    watchlistStore.reload()
    expect(watchlistStore.get()).toEqual(['MSFT', 'NVDA'])
  })

  it('손상된 값은 빈 목록으로 복구한다 (문자열만 남긴다) / recovers from junk to an empty list, keeping only strings', () => {
    localStorage.setItem(WATCHLIST_KEY, '{"not":"a list"}')
    watchlistStore.reload()
    expect(watchlistStore.get()).toEqual([])

    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(['AAPL', 7, null]))
    watchlistStore.reload()
    expect(watchlistStore.get()).toEqual(['AAPL'])
  })

  it('useWatchlist는 변경을 따라간다 / useWatchlist follows changes', () => {
    const { result } = renderHook(() => useWatchlist())
    expect(result.current.has('AAPL')).toBe(false)

    act(() => result.current.toggle('AAPL'))
    expect(result.current.has('AAPL')).toBe(true)
    expect(result.current.symbols).toEqual(['AAPL'])
  })
})
