import { describe, expect, it } from 'vitest'
import type { Quote } from '../api/types.ts'
import { summarizeQuotes } from './marketSummary.ts'

const quote = (symbol: string, change_pct: number, volume = 10): Quote => ({
  symbol, name: symbol, price: 100, change: change_pct, change_pct, volume,
  market: 'us', currency: 'USD', sector: 'Technology', market_cap: null,
})

describe('summarizeQuotes', () => {
  it('보합을 포함한 관측 종목으로 상승 비중을 계산한다 / includes flat stocks in breadth', () => {
    const summary = summarizeQuotes([quote('UP', 2), quote('DOWN', -1), quote('FLAT', 0), quote('FLAT2', 0)])
    expect(summary).toMatchObject({ total: 4, advancing: 1, declining: 1, unchanged: 2, advancingPct: 25 })
  })

  it('상승·하락 목록은 부호가 맞는 종목만 담고 원본 순서를 바꾸지 않는다 / sign-correct leaders without cache mutation', () => {
    const quotes = [quote('A', 1, 50), quote('B', -4, 80), quote('C', 3, 20), quote('D', -1, 100), quote('E', 0)]
    const summary = summarizeQuotes(quotes)
    expect(summary.gainers.map(q => q.symbol)).toEqual(['C', 'A'])
    expect(summary.losers.map(q => q.symbol)).toEqual(['B', 'D'])
    expect(summary.volume.map(q => q.symbol)).toEqual(['D', 'B', 'A'])
    expect(quotes.map(q => q.symbol)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('빈 시장에 가짜 비율이나 종목을 만들지 않는다 / no invented ratio or leaders for empty data', () => {
    expect(summarizeQuotes([])).toMatchObject({
      total: 0, advancing: 0, declining: 0, unchanged: 0, advancingPct: null,
      gainers: [], losers: [], volume: [],
    })
  })
})
