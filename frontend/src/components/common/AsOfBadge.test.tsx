/**
 * AsOfBadge 테스트 — "N분 전 기준"은 stale-while-error의 신뢰 신호이므로 60초 경계를 고정한다.
 * AsOfBadge tests; "N분 전 기준" is the stale-while-error trust signal, so the 60s boundary is pinned.
 */
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AsOfBadge } from './AsOfBadge.tsx'

const NOW = new Date('2026-08-02T09:00:00.000Z')

/**
 * Date만 가짜로 만든다 — setTimeout까지 가로채면 React 렌더 스케줄러가 멈출 수 있다.
 * Fake only Date: intercepting setTimeout as well can stall React's render scheduler.
 */
function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
}

afterEach(() => {
  vi.useRealTimers()
})

/** NOW 기준 n초 전의 ISO 문자열 / An ISO string n seconds before NOW */
function secondsAgo(n: number): string {
  return new Date(NOW.getTime() - n * 1000).toISOString()
}

describe('AsOfBadge', () => {
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
})
