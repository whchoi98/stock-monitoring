/**
 * Clock 테스트 — KST 고정 표기와 1초 갱신을 못박는다 / Clock tests, pinning the fixed KST rendering and the 1s tick.
 */
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Clock } from './Clock.tsx'

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-09-06T00:00:00Z') })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Clock', () => {
  it('서울 시각을 HH:MM:SS KST로 렌더한다 / renders Seoul time as HH:MM:SS KST', () => {
    render(<Clock />)
    expect(screen.getByText('09:00:00 KST')).toBeTruthy()
  })

  it('1초마다 갱신된다 / ticks once a second', () => {
    render(<Clock />)
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.getByText('09:00:01 KST')).toBeTruthy()
  })

  it('언마운트 후에는 타이머가 남지 않는다 / leaves no timer behind after unmount', () => {
    const { unmount } = render(<Clock />)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
