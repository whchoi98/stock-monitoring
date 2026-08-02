/**
 * 차트 데이터 변환 — 백엔드 `ChartData`를 lightweight-charts 입력 형식으로 바꾸는 순수 함수들.
 * Chart data transforms: pure functions turning the backend's `ChartData` into lightweight-charts input.
 *
 * 차트 렌더링은 jsdom에서 돌지 않으므로(canvas 없음) 검증 가치가 있는 로직은 전부 여기 있고,
 * `PriceChart.tsx`는 이 함수들을 부르는 얇은 껍데기다. 여기에는 DOM도 React도 없다.
 * Chart rendering cannot run under jsdom (no canvas), so every piece of logic worth checking lives here
 * and `PriceChart.tsx` is a thin shell over it. Nothing here touches the DOM or React.
 */
import type {
  CandlestickData,
  LineData,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'

import type { Candle, CrossSignal } from '../../api/types.ts'

/** 마커 색 — 실제 값은 `PriceChart`가 CSS 토큰에서 읽어 넘긴다 / Marker colours, read from the CSS tokens by `PriceChart` */
export interface MarkerColors {
  /** 골든 크로스 색 (상승) / The golden cross colour (up) */
  golden: string
  /** 데드 크로스 색 (하락) / The dead cross colour (down) */
  dead: string
}

/** 일봉 라벨 형식 — 라이브러리가 문자열 시각으로 받아주는 유일한 형식 / The only string time the library accepts */
const DAILY_TIME = /^\d{4}-\d{2}-\d{2}$/

/**
 * 백엔드 시각 라벨을 라이브러리 시각으로 / A backend time label as a library time.
 *
 * 백엔드는 두 형식을 낸다 (`backend/app/services/charts.py`): 일봉 이상은 `YYYY-MM-DD`,
 * 1w처럼 분/시간 간격은 `YYYY-MM-DDTHH:MM`.
 * 그런데 lightweight-charts v4가 문자열로 받는 건 앞의 형식뿐이다 — 개발 빌드는 그 외 문자열에
 * throw하고, 프로덕션 빌드는 시각 부분을 조용히 버려 같은 날 캔들들이 중복 시각으로 뭉친다
 * (그러면 "data must be asc ordered by time"으로 차트 전체가 죽는다).
 * 그래서 시간봉은 UTCTimestamp(초)로 바꾼다. 백엔드 문자열에는 오프셋이 없으므로(거래소 현지시각을
 * naive하게 찍는다) UTC로 해석한다 — 라이브러리가 UTCTimestamp 라벨을 UTC로 찍으므로 축 라벨이
 * 백엔드 문자열과 정확히 같아진다.
 *
 * The backend emits two shapes (`backend/app/services/charts.py`): `YYYY-MM-DD` for daily and coarser,
 * `YYYY-MM-DDTHH:MM` for intraday intervals such as 1w's hourly bars. lightweight-charts v4 only takes
 * the former as a string: its development build throws on anything else, and its production build
 * silently drops the clock part, collapsing a day's candles onto one duplicated time (which kills the
 * whole chart with "data must be asc ordered by time"). So intraday labels become a UTCTimestamp in
 * seconds. The backend string carries no offset (it stamps exchange-local time naively), so it is read
 * as UTC; the library renders UTCTimestamp labels in UTC, which makes the axis match the string exactly.
 *
 * @returns 라이브러리 시각, 해석 불가하면 null (호출부가 그 점을 버린다) /
 *          The library time, or null when it cannot be read, in which case callers drop the point.
 */
export function toChartTime(time: string): Time | null {
  if (DAILY_TIME.test(time)) return time
  // 오프셋이 없는 문자열은 실행 환경의 시간대로 해석되므로 Z를 붙여 UTC로 고정한다
  // A string without an offset would be read in the host's zone, so Z pins it to UTC
  const ms = Date.parse(`${time}Z`)
  return Number.isNaN(ms) ? null : ((ms / 1000) as UTCTimestamp)
}

/**
 * 캔들 시리즈 / The candlestick series.
 *
 * 거래량은 캔들에 넣지 않는다 — 별도 히스토그램 시리즈가 쓴다.
 * Volume is left out of the candles; the separate histogram series consumes it.
 */
export function toCandleSeries(candles: Candle[]): CandlestickData<Time>[] {
  const points: CandlestickData<Time>[] = []
  for (const { time, open, high, low, close } of candles) {
    const chartTime = toChartTime(time)
    if (chartTime === null) continue
    points.push({ time: chartTime, open, high, low, close })
  }
  return points
}

/**
 * 라인/히스토그램 시리즈 — `{time, value}` 한 종류로 둘 다 쓴다 (MA 라인 + 거래량 히스토그램).
 * The line and histogram series; one `{time, value}` shape serves both (the MAs and the volume bars).
 *
 * `values`의 null은 제거한다 — 백엔드 MA는 `candles`와 같은 길이이고 워밍업 구간(ma5는 앞 4개,
 * ma20은 앞 19개)이 null이다. 라인 시리즈는 null을 받을 수 없고, 남은 점은 각자 자기 시각을 갖는다.
 * 길이가 어긋나면 짧은 쪽에서 멈춘다 (계약상 같은 길이지만 짝 없는 값을 만들지는 않는다).
 * Nulls in `values` are removed: the backend's MAs are as long as `candles` with a null warm-up region
 * (four points for ma5, nineteen for ma20), a line series cannot take null, and each survivor keeps its
 * own time. Mismatched lengths stop at the shorter side — the contract says they match, but no value is
 * ever paired with a time that does not exist.
 */
export function toLineSeries(times: string[], values: (number | null)[]): LineData<Time>[] {
  const length = Math.min(times.length, values.length)
  const points: LineData<Time>[] = []
  for (let i = 0; i < length; i += 1) {
    const value = values[i]!
    if (value === null) continue
    const time = toChartTime(times[i]!)
    if (time === null) continue
    points.push({ time, value })
  }
  return points
}

/**
 * 크로스 신호 마커 — 골든은 캔들 아래 상승색 위 화살표, 데드는 캔들 위 하락색 아래 화살표.
 * Cross-signal markers: golden is an up arrow below the bar in the up colour, dead is a down arrow
 * above the bar in the down colour.
 *
 * 색은 인자로 받는다 — `SeriesMarker.color`가 필수인데 토큰 값은 DOM에서만 읽을 수 있어
 * 이 함수는 순수하게 남을 수 없기 때문이다.
 * The colours arrive as an argument: `SeriesMarker.color` is required, and the token values can only be
 * read from the DOM, which would otherwise cost this function its purity.
 */
export function toMarkers(signals: CrossSignal[], colors: MarkerColors): SeriesMarker<Time>[] {
  const markers: SeriesMarker<Time>[] = []
  for (const signal of signals) {
    const time = toChartTime(signal.time)
    if (time === null) continue
    markers.push(
      signal.kind === 'golden'
        ? { time, position: 'belowBar', shape: 'arrowUp', color: colors.golden }
        : { time, position: 'aboveBar', shape: 'arrowDown', color: colors.dead },
    )
  }
  return markers
}
