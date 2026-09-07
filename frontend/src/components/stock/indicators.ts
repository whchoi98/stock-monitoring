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
