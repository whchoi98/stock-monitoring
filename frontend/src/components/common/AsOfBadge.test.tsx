/**
 * AsOfBadge 테스트 — "N분 전 기준"은 stale-while-error의 신뢰 신호이므로 60초 경계를 고정한다.
 * AsOfBadge tests; "N분 전 기준" is the stale-while-error trust signal, so the 60s boundary is pinned.
 */
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AsOfBadge } from './AsOfBadge.tsx'

const NOW = new Date('2026-08-02T09:00:00.000Z')

/**
 * 컴포넌트가 실제로 쓰는 것만 가짜로 만든다 (Date + interval) — setTimeout/마이크로태스크까지
 * 가로채면 React 렌더 스케줄러가 멈출 수 있다.
 * Fake only what the component actually uses (Date plus the interval): intercepting setTimeout or
 * microtasks as well can stall React's render scheduler.
 */
function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW })
}

afterEach(() => {
  vi.useRealTimers()
})

/** NOW 기준 n초 전의 ISO 문자열 / An ISO string n seconds before NOW */
function secondsAgo(n: number): string {
  return new Date(NOW.getTime() - n * 1000).toISOString()
}

describe('AsOfBadge', () => {
  it('오래된 재무 데이터 기준 시각은 시간·일 단위로 읽힌다 / long-lived data uses hours and days', () => {
    freezeClock()
    const { container, rerender } = render(<AsOfBadge asOf={secondsAgo(2 * 60 * 60)} />)
    expect(container.textContent).toBe('2시간 전 기준')
    rerender(<AsOfBadge asOf={secondsAgo(2 * 24 * 60 * 60)} />)
    expect(container.textContent).toBe('2일 전 기준')
  })
  it('60초 미만은 아무것도 렌더하지 않는다 / renders nothing under 60s', () => {
    freezeClock()
    const { container } = render(<AsOfBadge asOf={secondsAgo(59)} />)
    expect(container.innerHTML).toBe('')
  })

  it('정확히 60초 경과는 "1분 전 기준" / shows "1분 전 기준" at exactly 60s', () => {
    freezeClock()
    const { container } = render(<AsOfBadge asOf={secondsAgo(60)} />)
    expect(container.textContent).toBe('1분 전 기준')
  })

  it('경과 분은 내림한다 / floors the elapsed minutes', () => {
    freezeClock()
    const { container } = render(<AsOfBadge asOf={secondsAgo(125)} />)
    expect(container.textContent).toBe('2분 전 기준')
  })

  it('미래 시각(시계 오차)은 렌더하지 않는다 / renders nothing for a future timestamp (clock skew)', () => {
    freezeClock()
    const { container } = render(<AsOfBadge asOf={secondsAgo(-300)} />)
    expect(container.innerHTML).toBe('')
  })

  it('asOf가 없거나 파싱 불가면 렌더하지 않는다 / renders nothing when asOf is missing or unparseable', () => {
    freezeClock()
    expect(render(<AsOfBadge asOf={undefined} />).container.innerHTML).toBe('')
    expect(render(<AsOfBadge asOf="not-a-date" />).container.innerHTML).toBe('')
  })

  /*
   * ── UI 클럭 / The UI clock ──
   *
   * 부모 재렌더는 기대할 수 없다: 백엔드가 stale-while-error로 같은 JSON을 계속 서빙하면
   * TanStack Query의 structural sharing 때문에 참조가 그대로여서 옵저버가 알림을 받지 않는다.
   * 그래서 뱃지는 부모가 한 번도 다시 렌더되지 않아도 스스로 나타나고 갱신되어야 한다.
   * A parent re-render cannot be expected: while the backend keeps serving identical JSON under
   * stale-while-error, TanStack Query's structural sharing keeps the reference and no observer is
   * notified. The badge must therefore appear and update with the parent never re-rendering.
   */
  it('부모가 다시 렌더되지 않아도 stale이 되면 스스로 나타난다 / appears on its own once stale, with no parent re-render', () => {
    freezeClock()
    let parentRenders = 0
    function Parent() {
      parentRenders += 1
      // asOf는 절대 바뀌지 않는다 — 백엔드가 같은 stale 응답을 반복 서빙하는 상황 / asOf never changes: the backend repeats one stale response
      return <AsOfBadge asOf={NOW.toISOString()} />
    }

    const { container } = render(<Parent />)
    expect(container.innerHTML).toBe('')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(container.textContent).toBe('1분 전 기준')
    expect(parentRenders).toBe(1)
  })

  it('이미 뜬 뱃지의 경과 시간도 계속 갱신된다 / keeps the elapsed time of a shown badge up to date', () => {
    freezeClock()
    const { container } = render(<AsOfBadge asOf={secondsAgo(70)} />)
    expect(container.textContent).toBe('1분 전 기준')

    // 뱃지가 첫 표기("1분 전")에 얼어붙으면 10분 뒤에도 틀린 신선도를 주장하게 된다.
    // A badge frozen at its first wording ("1분 전") would still claim it ten minutes later.
    act(() => {
      vi.advanceTimersByTime(10 * 60_000)
    })

    expect(container.textContent).toBe('11분 전 기준')
  })

  it('asOf가 없으면 클럭을 걸지 않는다 / starts no clock while asOf is absent', () => {
    freezeClock()
    render(<AsOfBadge asOf={undefined} />)
    expect(vi.getTimerCount()).toBe(0)
  })
})
