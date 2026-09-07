/**
 * 지표 계산 테스트 — 볼린저 밴드의 워밍업·상수열·알려진 값, 캔들 요약의 변동 계산.
 * Indicator maths tests: Bollinger warm-up, a constant series, a known case; the candle summary's change maths.
 */
import { describe, expect, it } from 'vitest'

import type { Candle } from '../../api/types.ts'
import { bollingerBands, summarizeCandle } from './indicators.ts'

describe('bollingerBands', () => {
  it('표본이 창보다 짧으면 전부 null / all null when shorter than the window', () => {
    const bands = bollingerBands([1, 2, 3], 5)
    expect(bands.upper).toEqual([null, null, null])
    expect(bands.middle).toEqual([null, null, null])
    expect(bands.lower).toEqual([null, null, null])
  })

  it('상수열은 세 줄이 모두 그 값이다 / a constant series collapses all three lines onto the value', () => {
    const bands = bollingerBands([7, 7, 7, 7, 7, 7], 5, 2)
    expect(bands.upper.slice(0, 4)).toEqual([null, null, null, null])
    expect(bands.upper.slice(4)).toEqual([7, 7])
    expect(bands.middle.slice(4)).toEqual([7, 7])
    expect(bands.lower.slice(4)).toEqual([7, 7])
  })

  it('알려진 값 — 1..5, 창 5, 2σ: 평균 3, 모집단 σ √2 / a known case: mean 3, population σ √2', () => {
    const bands = bollingerBands([1, 2, 3, 4, 5], 5, 2)
    const sigma = Math.sqrt(2)
    expect(bands.middle[4]).toBeCloseTo(3, 10)
    expect(bands.upper[4]).toBeCloseTo(3 + 2 * sigma, 10)
    expect(bands.lower[4]).toBeCloseTo(3 - 2 * sigma, 10)
  })

  it('창이 미끄러진다 — 길이가 입력과 같고 뒤쪽 값이 앞쪽 값에 영향을 받지 않는다 / the window slides: output length matches and late values ignore early ones', () => {
    const bands = bollingerBands([100, 1, 1, 1, 1, 1], 3)
    expect(bands.middle).toHaveLength(6)
    // 마지막 창 [1,1,1]은 100을 포함하지 않는다 / The last window [1,1,1] no longer sees the 100
    expect(bands.middle[5]).toBeCloseTo(1, 10)
    expect(bands.upper[5]).toBeCloseTo(1, 10)
  })
})

function candle(time: string, close: number, volume = 1000): Candle {
  return { time, open: close - 1, high: close + 1, low: close - 2, close, volume }
}

describe('summarizeCandle', () => {
  const CANDLES = [candle('2026-09-01', 100), candle('2026-09-02', 102), candle('2026-09-03', 99.96)]

  it('직전 종가 대비 변동과 퍼센트를 낸다 / reports the change and percentage against the previous close', () => {
    const summary = summarizeCandle(CANDLES, 1)!
    expect(summary.close).toBe(102)
    expect(summary.change).toBeCloseTo(2, 10)
    expect(summary.changePct).toBeCloseTo(2, 10)
    expect(summary.volume).toBe(1000)
  })

  it('첫 캔들은 변동이 null / the first candle has no change', () => {
    const summary = summarizeCandle(CANDLES, 0)!
    expect(summary.change).toBeNull()
    expect(summary.changePct).toBeNull()
  })

  it('하락은 음수로 / a fall is negative', () => {
    const summary = summarizeCandle(CANDLES, 2)!
    expect(summary.change).toBeCloseTo(-2.04, 10)
    expect(summary.changePct).toBeCloseTo(-2, 10)
  })

  it('범위 밖이면 null / out of range is null', () => {
    expect(summarizeCandle(CANDLES, 3)).toBeNull()
    expect(summarizeCandle([], 0)).toBeNull()
  })

  it('직전 종가가 0이면 퍼센트는 null / a zero previous close yields no percentage', () => {
    const summary = summarizeCandle([candle('a', 0), candle('b', 5)], 1)!
    expect(summary.change).toBe(5)
    expect(summary.changePct).toBeNull()
  })
})
