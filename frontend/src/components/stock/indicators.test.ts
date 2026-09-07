/**
 * 지표 계산 테스트 — 볼린저 밴드의 워밍업·상수열·알려진 값, 캔들 요약의 변동 계산.
 * Indicator maths tests: Bollinger warm-up, a constant series, a known case; the candle summary's change maths.
 */
import { describe, expect, it } from 'vitest'

import type { Candle } from '../../api/types.ts'
import { bollingerBands, ema, macd, rsi, summarizeCandle } from './indicators.ts'

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

describe('rsi', () => {
  it('앞 period개는 null, 길이는 입력과 같다 / the first period entries are null and the length matches', () => {
    const out = rsi([1, 2, 3, 4, 5, 6], 3)
    expect(out).toHaveLength(6)
    expect(out.slice(0, 3)).toEqual([null, null, null])
    expect(out.slice(3).every((v) => v !== null)).toBe(true)
  })

  it('표본이 period 이하면 전부 null / all null when the sample is not longer than the period', () => {
    expect(rsi([1, 2, 3], 3)).toEqual([null, null, null])
  })

  it('계속 오르면 100, 계속 내리면 0, 보합이면 50 / all-up is 100, all-down 0, flat 50', () => {
    expect(rsi([1, 2, 3, 4, 5], 3).at(-1)).toBe(100)
    expect(rsi([5, 4, 3, 2, 1], 3).at(-1)).toBe(0)
    expect(rsi([3, 3, 3, 3, 3], 3).at(-1)).toBe(50)
  })

  it('알려진 값 — [1,2,3,2,3], period 3 / a known case', () => {
    // 첫 RSI: 이익 평균 2/3, 손실 평균 1/3 → RS 2 → 66.67. 다음: 이익 (2/3·2+1)/3, 손실 (1/3·2)/3 → RS 3.5 → 77.78
    // First RSI: avg gain 2/3, avg loss 1/3 → RS 2 → 66.67. Next: gain (2/3·2+1)/3, loss (1/3·2)/3 → RS 3.5 → 77.78
    const out = rsi([1, 2, 3, 2, 3], 3)
    expect(out[3]).toBeCloseTo(66.6667, 3)
    expect(out[4]).toBeCloseTo(77.7778, 3)
  })

  it('항상 0~100 안에 있다 / always within 0..100', () => {
    const noisy = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 10 + (i % 7))
    for (const v of rsi(noisy)) if (v !== null) expect(v >= 0 && v <= 100).toBe(true)
  })
})

describe('ema / macd', () => {
  it('상수열의 EMA는 그 값, MACD는 0이다 / a constant series gives the constant EMA and a zero MACD', () => {
    const flat = new Array<number>(40).fill(10)
    expect(ema(flat, 5).slice(4).every((v) => v === 10)).toBe(true)
    const out = macd(flat)
    expect(out.macd.slice(25).every((v) => v === 0)).toBe(true)
    expect(out.signal.slice(33).every((v) => v === 0)).toBe(true)
    expect(out.histogram.slice(33).every((v) => v === 0)).toBe(true)
  })

  it('워밍업 — MACD는 slow−1, 시그널은 slow−1+signal−1 앞이 null / warm-up nulls', () => {
    const values = Array.from({ length: 50 }, (_, i) => i + 1)
    const out = macd(values, 12, 26, 9)
    expect(out.macd.slice(0, 25).every((v) => v === null)).toBe(true)
    expect(out.macd[25]).not.toBeNull()
    expect(out.signal.slice(0, 33).every((v) => v === null)).toBe(true)
    expect(out.signal[33]).not.toBeNull()
    expect(out.histogram[33]).not.toBeNull()
    expect(out.macd).toHaveLength(50)
  })

  it('EMA 씨앗은 앞 period개의 단순 평균이다 / the EMA seed is the simple mean of the first period values', () => {
    const out = ema([1, 2, 3, 4], 3)
    expect(out).toEqual([null, null, 2, expect.closeTo(3, 10)])
  })

  it('상승 추세에서는 MACD가 양수다 / an uptrend yields a positive MACD', () => {
    const rising = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i)
    const out = macd(rising)
    expect(out.macd.at(-1)!).toBeGreaterThan(0)
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
