/**
 * MarketStrip 테스트 — 데이터가 없을 때 앱을 막지 않는 것, 지수 고정 셀과 지표 크롤의 분리, 단위 표기가 핵심이다.
 * MarketStrip tests; the essentials are never blocking the app without data, the split between fixed index cells
 * and the indicator crawl, and the unit notation.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { IndexQuote, Indicator } from '../../api/types.ts'
import { MarketStrip } from './MarketStrip.tsx'

const SPX: IndexQuote = { symbol: '^GSPC', name: 'S&P 500', value: 6489.72, change: 52.09, change_pct: 0.81 }
const KOSPI: IndexQuote = { symbol: '^KS11', name: 'KOSPI', value: 3210.5, change: -12.3, change_pct: -0.38 }

const OIL: Indicator = { symbol: 'CL=F', name: 'WTI Oil', value: 78.5, change: 0.92, change_pct: 1.19, unit: '$' }
const TNX: Indicator = { symbol: '^TNX', name: 'US 10Y', value: 4.25, change: -0.03, change_pct: -0.7, unit: '%' }
const FLAT: Indicator = { symbol: 'KRW=X', name: 'USD/KRW', value: 1351.1, change: 0, change_pct: 0, unit: 'W' }

describe('MarketStrip', () => {
  it('지수도 지표도 없으면 아무것도 렌더하지 않는다 (asOf가 있어도) / renders nothing without indices or indicators, even with asOf', () => {
    const { container } = render(
      <MarketStrip indices={[]} indicators={[]} asOf="2026-08-03T05:32:00+00:00" />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('지수는 고정 셀에 값과 등락률을 렌더한다 / renders indices as fixed cells with value and change', () => {
    const { container } = render(<MarketStrip indices={[SPX, KOSPI]} indicators={[]} />)

    const fixed = container.querySelector('.strip-indices')!
    expect(fixed.querySelectorAll('.strip-cell')).toHaveLength(2)
    expect(screen.getByText('S&P 500')).toBeTruthy()
    expect(screen.getByText('6,489.72')).toBeTruthy()
    expect(screen.getByText('▲+0.81%').classList.contains('up')).toBe(true)
    expect(screen.getByText('▼-0.38%').classList.contains('down')).toBe(true)
    // 지표가 없으면 크롤도 없다 / No indicators, no crawl
    expect(container.querySelector('.strip-crawl')).toBeNull()
  })

  it('$ 단위는 앞에, 나머지 단위는 뒤에 붙인다 / puts $ before the value and other units after', () => {
    render(<MarketStrip indices={[]} indicators={[OIL, TNX, FLAT]} />)
    expect(screen.getAllByText('$78.50').length).toBeGreaterThan(0)
    expect(screen.getAllByText('4.25%').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1,351.10W').length).toBeGreaterThan(0)
  })

  it('보합 지표는 대시 하나만 낸다 / a flat indicator collapses to a dash', () => {
    render(<MarketStrip indices={[]} indicators={[FLAT]} />)
    expect(screen.getAllByText('-')[0]!.classList.contains('flat')).toBe(true)
  })

  it('크롤 사본은 스크린리더에서 숨긴다 / hides the crawl copy from screen readers', () => {
    const { container } = render(<MarketStrip indices={[SPX]} indicators={[OIL]} />)
    // 지표는 두 벌(원본 + aria-hidden 사본), 지수는 한 벌 / Indicators twice (original plus hidden copy), indices once
    expect(screen.getAllByText('WTI Oil')).toHaveLength(2)
    expect(screen.getAllByText('S&P 500')).toHaveLength(1)
    expect(container.querySelectorAll('.strip-crawl [aria-hidden="true"]')).toHaveLength(1)
  })

  it('asOf가 있으면 HH:MM 기준 칩을 렌더한다 / renders the HH:MM as-of chip when asOf is given', () => {
    render(<MarketStrip indices={[SPX]} indicators={[]} asOf="2026-08-03T05:32:00+00:00" />)
    const chip = screen.getByTitle('데이터 기준 시각 2026-08-03T05:32:00+00:00')
    // 시간대는 실행 환경에 따라 다르므로 형식만 고정한다 / The zone varies by host, so only the shape is pinned
    expect(chip.textContent).toMatch(/^\d{2}:\d{2} 기준$/)
  })

  it('asOf가 없거나 파싱 불가면 칩을 렌더하지 않는다 / renders no chip without a usable asOf', () => {
    const { rerender } = render(<MarketStrip indices={[SPX]} indicators={[]} />)
    expect(screen.queryByTitle(/데이터 기준 시각/)).toBeNull()
    rerender(<MarketStrip indices={[SPX]} indicators={[]} asOf="not-a-date" />)
    expect(screen.queryByTitle(/데이터 기준 시각/)).toBeNull()
  })
})
