/**
 * 차트 지표 계산 — 백엔드가 주지 않는 지표(볼린저 밴드)와 레전드용 캔들 요약을 만드는 순수 함수.
 * Chart indicator maths: pure functions for what the backend does not send (Bollinger Bands) and the candle
 * summary the legend shows. No DOM, no React — everything here is unit-tested directly.
 *
 * MA5/MA20은 백엔드(`ChartData.ma5/ma20`)가 주므로 여기서 다시 계산하지 않는다.
 * MA5/MA20 arrive from the backend (`ChartData.ma5/ma20`) and are not recomputed here.
 */
import type { Candle } from '../../api/types.ts'

/** 볼린저 밴드 세 줄 — `values`와 같은 길이, 워밍업 구간은 null / The three Bollinger lines, as long as `values`, null during warm-up */
export interface Bands {
  upper: (number | null)[]
  middle: (number | null)[]
  lower: (number | null)[]
}

/**
 * 볼린저 밴드 (기본 20, 2σ) — 이동평균 ± k × **모집단** 표준편차. 트레이딩 플랫폼(TradingView 등)의 관례다.
 * Bollinger Bands (default 20, 2σ): the moving average ± k × the **population** standard deviation, the convention
 * trading platforms (TradingView among them) use.
 *
 * 표본이 `window`보다 짧으면 전부 null이다 — 밴드를 그리지 않는다는 신호다.
 * Shorter than `window` yields all nulls, the signal to draw no band.
 */
export function bollingerBands(values: number[], window = 20, k = 2): Bands {
  const upper: (number | null)[] = []
  const middle: (number | null)[] = []
  const lower: (number | null)[] = []
  let sum = 0
  let sumSquares = 0

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]!
    sum += value
    sumSquares += value * value
    if (i >= window) {
      const dropped = values[i - window]!
      sum -= dropped
      sumSquares -= dropped * dropped
    }
    if (i < window - 1) {
      upper.push(null)
      middle.push(null)
      lower.push(null)
      continue
    }
    const mean = sum / window
    // 부동소수 오차로 음수가 될 수 있는 분산을 0으로 자른다 / Clamp a variance that floating-point error can push below zero
    const variance = Math.max(0, sumSquares / window - mean * mean)
    const deviation = Math.sqrt(variance)
    upper.push(mean + k * deviation)
    middle.push(mean)
    lower.push(mean - k * deviation)
  }

  return { upper, middle, lower }
}

/**
 * RSI (기본 14) — Wilder 평활. 첫 값은 앞 `period`개 변동의 단순 평균, 이후 `(이전×(n−1) + 현재)/n`.
 * 손실 평균이 0이면 100, 이익·손실이 모두 0(완전 보합)이면 50으로 둔다.
 * RSI (default 14) with Wilder smoothing: the first value averages the first `period` changes, then
 * `(previous×(n−1) + current)/n`. A zero average loss yields 100; zero on both sides (a flat series) yields 50.
 *
 * 앞 `period`개는 null이다 (변동이 `period`개 쌓여야 첫 값이 나온다).
 * The first `period` entries are null: the first value needs `period` changes.
 */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null)
  if (values.length <= period) return out

  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i += 1) {
    const change = values[i]! - values[i - 1]!
    if (change > 0) avgGain += change
    else avgLoss -= change
  }
  avgGain /= period
  avgLoss /= period

  const toRsi = (gain: number, loss: number): number => {
    if (loss === 0) return gain === 0 ? 50 : 100
    const rs = gain / loss
    return 100 - 100 / (1 + rs)
  }

  out[period] = toRsi(avgGain, avgLoss)
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? -change : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = toRsi(avgGain, avgLoss)
  }
  return out
}

/**
 * 지수이동평균 — 앞 `period`개의 단순 평균으로 씨앗을 삼고 `k = 2/(period+1)`로 잇는다. 워밍업 구간은 null.
 * An exponential moving average seeded with the simple mean of the first `period` values, then `k = 2/(period+1)`; null
 * during warm-up.
 */
export function ema(values: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null)
  const k = 2 / (period + 1)
  // 첫 유효 구간(null이 아닌 값이 `period`개 연속)을 찾아 씨앗을 만든다 / Seed on the first run of `period` non-null values
  let count = 0
  let sum = 0
  let prev: number | null = null
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (value === null || value === undefined) {
      if (prev === null) {
        count = 0
        sum = 0
      }
      continue
    }
    if (prev === null) {
      count += 1
      sum += value
      if (count === period) {
        prev = sum / period
        out[i] = prev
      }
      continue
    }
    prev = value * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** MACD 세 줄 / The three MACD series */
export interface Macd {
  macd: (number | null)[]
  signal: (number | null)[]
  histogram: (number | null)[]
}

/**
 * MACD (12, 26, 9) — `EMA(fast) − EMA(slow)`, 시그널은 그 EMA(signal), 히스토그램은 차이. 워밍업 구간은 null.
 * MACD (12, 26, 9): `EMA(fast) − EMA(slow)`, the signal is its EMA(signal), the histogram the difference; null while
 * warming up.
 */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const emaFast = ema(values, fast)
  const emaSlow = ema(values, slow)
  const line = values.map((_, i) => {
    const f = emaFast[i]
    const s = emaSlow[i]
    return f === null || f === undefined || s === null || s === undefined ? null : f - s
  })
  const signal = ema(line, signalPeriod)
  const histogram = line.map((m, i) => {
    const s = signal[i]
    return m === null || s === null || s === undefined ? null : m - s
  })
  return { macd: line, signal, histogram }
}

/** 레전드가 보여주는 캔들 한 개의 요약 / One candle's summary as the legend shows it */
export interface CandleSummary {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** 직전 캔들 종가 대비 변동 — 첫 캔들은 null / The change against the previous close; null on the first candle */
  change: number | null
  /** 퍼센트 스케일 (1.5 === +1.5%) — 직전 종가가 0이면 null / Percent scale; null when the previous close is 0 */
  changePct: number | null
}

/**
 * `index`번째 캔들을 요약한다. 범위 밖이면 null.
 * Summarise the candle at `index`; null when out of range.
 */
export function summarizeCandle(candles: Candle[], index: number): CandleSummary | null {
  const candle = candles[index]
  if (candle === undefined) return null
  const previous = index > 0 ? candles[index - 1] : undefined
  const change = previous === undefined ? null : candle.close - previous.close
  const changePct =
    previous === undefined || previous.close === 0 || change === null
      ? null
      : (change / previous.close) * 100
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    change,
    changePct,
  }
}
