/**
 * TickerBar 테스트 — 지표가 없을 때(로딩/실패) 앱을 막지 않는 것과 단위 표기가 핵심이다.
 * TickerBar tests; the essentials are never blocking the app when indicators are absent
 * (loading or failed) and the unit notation.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Indicator } from '../../api/types.ts'
import { TickerBar } from './TickerBar.tsx'

const OIL: Indicator = {
  symbol: 'CL=F',
  name: 'WTI Oil',
  value: 78.5,
  change: 0.92,
  change_pct: 1.19,
  unit: '$',
}

const TNX: Indicator = {
  symbol: '^TNX',
  name: 'US 10Y',
  value: 4.25,
  change: -0.03,
  change_pct: -0.7,
  unit: '%',
}

describe('TickerBar', () => {
  it('지표가 없으면 아무것도 렌더하지 않는다 / renders nothing without indicators', () => {
    const { container } = render(<TickerBar indicators={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('$ 단위는 앞에, 나머지 단위는 뒤에 붙인다 / puts $ before the value and other units after', () => {
    render(<TickerBar indicators={[OIL, TNX]} />)
    expect(screen.getAllByText('$78.50').length).toBeGreaterThan(0)
    expect(screen.getAllByText('4.25%').length).toBeGreaterThan(0)
  })

  it('지표명과 등락을 함께 렌더한다 / renders the name alongside the change', () => {
    render(<TickerBar indicators={[OIL, TNX]} />)
    expect(screen.getAllByText('WTI Oil').length).toBeGreaterThan(0)
    expect(screen.getAllByText('▲+0.92 (+1.19%)').length).toBeGreaterThan(0)
    expect(screen.getAllByText('▼-0.03 (-0.70%)').length).toBeGreaterThan(0)
  })

  it('무한 스크롤용 사본은 스크린리더에서 숨긴다 / hides the seamless-scroll copy from screen readers', () => {
    const { container } = render(<TickerBar indicators={[OIL]} />)
    // 트랙을 한 벌 복제해 끊김 없이 순환시키므로, 사본은 aria-hidden이어야 중복 낭독이 없다.
    // The track is duplicated so the loop never gaps; the copy must be aria-hidden to avoid double reading.
    expect(screen.getAllByText('WTI Oil')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
  })
})
