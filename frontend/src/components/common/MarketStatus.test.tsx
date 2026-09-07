/**
 * MarketStatus 테스트 — 세 상태의 라벨과 "모름 ≠ 장마감"을 못박는다 / Three states, and unknown is not closed.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarketStatus } from './MarketStatus.tsx'

describe('MarketStatus', () => {
  it('true → 장중 / open', () => {
    render(<MarketStatus marketOpen={true} />)
    expect(screen.getByText('장중').classList.contains('status-open')).toBe(true)
  })

  it('false → 장마감 / closed', () => {
    render(<MarketStatus marketOpen={false} />)
    expect(screen.getByText('장마감').classList.contains('status-closed')).toBe(true)
  })

  it('undefined → 확인 중 (장마감으로 꾸미지 않는다) / unknown, never faked as closed', () => {
    render(<MarketStatus marketOpen={undefined} />)
    expect(screen.getByText('확인 중').classList.contains('status-unknown')).toBe(true)
    expect(screen.queryByText('장마감')).toBeNull()
  })
})
