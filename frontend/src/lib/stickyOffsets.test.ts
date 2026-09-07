/**
 * stickyOffsets 테스트 — 상단 고정 블록과 하단 상태 바의 **실측** 높이를 CSS 변수로 내보내, 토스트가 겹치지 않게 한다.
 * stickyOffsets tests: the measured heights of the sticky top block and the status bar become CSS variables so toasts
 * never overlap them.
 *
 * 토큰 `--term-top-h`(85px)·`--term-status-h`(28px)는 데스크톱 실측값이다. 좁은 화면에서는 커맨드 바·마켓 스트립·상태 바가
 * 줄바꿈해 125~184px / 38~59px가 되므로, 고정값에 붙인 토스트는 그 블록을 덮는다(2026-09-07 PWA 리뷰).
 * The tokens `--term-top-h` (85px) and `--term-status-h` (28px) are desktop measurements; on narrow screens the command
 * bar, market strip and status bar wrap to 125–184px / 38–59px, so toasts anchored to the tokens cover them (PWA review,
 * 2026-09-07).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { observeStickyOffsets, STICKY_BOTTOM_VAR, STICKY_TOP_VAR } from './stickyOffsets.ts'

type ResizeCallback = (entries: Array<{ target: Element; contentRect: { height: number } }>) => void

/** 콜백을 기록하고 수동으로 발화시킬 수 있는 ResizeObserver 대용 / A ResizeObserver stand-in whose callbacks can be fired by hand */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  callback: ResizeCallback
  observed: Element[] = []
  disconnected = false
  constructor(callback: ResizeCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }
  observe(target: Element) {
    this.observed.push(target)
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
}

function mount(): { top: HTMLElement; bottom: HTMLElement } {
  const top = document.createElement('div')
  top.className = 'term-top'
  const bottom = document.createElement('footer')
  bottom.className = 'statusbar'
  document.body.append(top, bottom)
  return { top, bottom }
}

beforeEach(() => {
  FakeResizeObserver.instances = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  document.documentElement.style.removeProperty(STICKY_TOP_VAR)
  document.documentElement.style.removeProperty(STICKY_BOTTOM_VAR)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('observeStickyOffsets', () => {
  it('두 고정 블록의 실측 높이를 CSS 변수로 내보낸다 / exports both sticky blocks’ measured heights as CSS variables', () => {
    const { top, bottom } = mount()
    vi.spyOn(top, 'getBoundingClientRect').mockReturnValue({ height: 125 } as DOMRect)
    vi.spyOn(bottom, 'getBoundingClientRect').mockReturnValue({ height: 59 } as DOMRect)

    observeStickyOffsets(document)

    // 관찰 시작 시 한 번 측정한다 / Measured once when observation starts
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe('125px')
    expect(document.documentElement.style.getPropertyValue(STICKY_BOTTOM_VAR)).toBe('59px')
    expect(FakeResizeObserver.instances[0].observed).toEqual([top, bottom])

    // 줄바꿈이 풀려 높이가 바뀌면 변수도 따라간다 / When a wrap clears and the height changes, the variable follows
    vi.spyOn(bottom, 'getBoundingClientRect').mockReturnValue({ height: 28 } as DOMRect)
    FakeResizeObserver.instances[0].callback([{ target: bottom, contentRect: { height: 28 } }])
    expect(document.documentElement.style.getPropertyValue(STICKY_BOTTOM_VAR)).toBe('28px')
  })

  it('해제하면 관찰을 끊고 변수를 지운다 — 토스트는 토큰 폴백으로 돌아간다 / cleanup disconnects and clears the variables, so toasts fall back to the tokens', () => {
    const { top, bottom } = mount()
    vi.spyOn(top, 'getBoundingClientRect').mockReturnValue({ height: 85 } as DOMRect)
    vi.spyOn(bottom, 'getBoundingClientRect').mockReturnValue({ height: 28 } as DOMRect)

    const stop = observeStickyOffsets(document)
    stop()

    expect(FakeResizeObserver.instances[0].disconnected).toBe(true)
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe('')
    expect(document.documentElement.style.getPropertyValue(STICKY_BOTTOM_VAR)).toBe('')
  })

  it('ResizeObserver가 없거나 블록이 없으면 아무 것도 하지 않는다 / does nothing without ResizeObserver or without the blocks', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    expect(() => observeStickyOffsets(document)()).not.toThrow()

    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    // 블록이 없는 문서 (예: 에러 화면) / A document without the blocks (e.g. an error screen)
    const stop = observeStickyOffsets(document)
    expect(FakeResizeObserver.instances).toHaveLength(0)
    expect(document.documentElement.style.getPropertyValue(STICKY_TOP_VAR)).toBe('')
    stop()
  })
})
