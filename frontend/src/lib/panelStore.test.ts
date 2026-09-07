/** 패널 접힘 스토어 테스트 / Collapsed-panel store tests */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { PANELS_KEY, panelStore, resetPanels, togglePanel, useCollapsedCount, usePanelCollapsed } from './panelStore.ts'

beforeEach(() => {
  localStorage.clear()
  panelStore.reload()
})

describe('panelStore', () => {
  it('토글하면 접히고 다시 토글하면 펼쳐진다 (펼침은 키를 지운다) / toggling collapses, toggling again expands and drops the key', () => {
    togglePanel('orderbook')
    expect(panelStore.get()).toEqual({ orderbook: true })
    expect(JSON.parse(localStorage.getItem(PANELS_KEY) ?? '{}')).toEqual({ orderbook: true })

    togglePanel('orderbook')
    expect(panelStore.get()).toEqual({})
  })

  it('초기화는 전부 펼친다 / reset expands everything', () => {
    togglePanel('a')
    togglePanel('b')
    resetPanels()
    expect(panelStore.get()).toEqual({})
  })

  it('훅은 id별 상태와 개수를 돌려준다 / the hooks report per-id state and the count', () => {
    const { result } = renderHook(() => ({ a: usePanelCollapsed('a'), none: usePanelCollapsed(undefined), n: useCollapsedCount() }))
    expect(result.current).toEqual({ a: false, none: false, n: 0 })

    act(() => togglePanel('a'))
    expect(result.current).toEqual({ a: true, none: false, n: 1 })
  })

  it('손상된 값은 무시한다 / junk is ignored', () => {
    localStorage.setItem(PANELS_KEY, JSON.stringify({ a: true, b: 'yes', c: false }))
    panelStore.reload()
    expect(panelStore.get()).toEqual({ a: true })

    localStorage.setItem(PANELS_KEY, '[1,2]')
    panelStore.reload()
    expect(panelStore.get()).toEqual({})
  })
})
