/** CandleTable 테스트 — 최신순, 등락률 색, 통화 포맷 / Newest first, change colour, currency formatting. */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Candle } from '../../api/types.ts'
import { CandleTable } from './CandleTable.tsx'

const CANDLES: Candle[] = [
  { time: '2026-09-01', open: 100, high: 105, low: 99, close: 104, volume: 1_200_000 },
  { time: '2026-09-02', open: 104, high: 106, low: 101, close: 102, volume: 900_000 },
  { time: '2026-09-03T10:00', open: 102, high: 103, low: 100, close: 102, volume: 500 },
]

describe('CandleTable', () => {
  it('최신 캔들이 위에 오고 첫 캔들의 등락률은 대시다 / newest first; the oldest candle has no change', () => {
    const { container } = render(<CandleTable candles={CANDLES} currency="USD" />)
    const rows = Array.from(container.querySelectorAll('tbody tr'))
    expect(rows.map((r) => r.querySelector('.cell-time')?.textContent)).toEqual([
      '2026-09-03 10:00',
      '2026-09-02',
      '2026-09-01',
    ])
    expect(rows[2]!.querySelectorAll('td')[5]!.textContent).toBe('—')
  })

  it('등락률은 직전 종가 대비이고 방향색을 갖는다 / the change is against the previous close and coloured', () => {
    const { container } = render(<CandleTable candles={CANDLES} currency="USD" />)
    const rows = Array.from(container.querySelectorAll('tbody tr'))
    // 2026-09-02: 104 → 102 = -1.92% / 2026-09-03: 102 → 102 = 보합
    expect(rows[1]!.classList.contains('down')).toBe(true)
    expect(rows[1]!.querySelectorAll('td')[5]!.textContent).toBe('▼-1.92%')
    expect(rows[0]!.querySelectorAll('td')[5]!.textContent).toBe('0.00%')
    expect(rows[0]!.querySelectorAll('td')[6]!.textContent).toBe('500')
  })

  it('KRW는 소수점 없이 / KRW without decimals', () => {
    const { container } = render(<CandleTable candles={[CANDLES[0]!]} currency="KRW" />)
    expect(container.querySelector('tbody td.cell-strong')?.textContent).toBe('104')
  })
})
