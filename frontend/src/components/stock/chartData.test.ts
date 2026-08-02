/**
 * chartData 변환 테스트 — lightweight-charts 입력 형식으로 바꾸는 순수 함수만 검증한다.
 * chartData transform tests; they cover only the pure functions that reshape data for lightweight-charts.
 *
 * 차트 렌더링 자체는 jsdom에서 돌지 않는다(canvas 없음). 그래서 검증 가치가 있는 로직 —
 * 시각 변환·null 제거·신호 매핑 — 을 `chartData.ts`로 분리해 여기서 직접 테스트한다
 * (`PriceChart.tsx`는 이 함수들을 부르는 얇은 껍데기로 남는다).
 * Chart rendering itself cannot run under jsdom (no canvas), so the logic worth checking — time
 * conversion, null stripping and signal mapping — lives in `chartData.ts` and is tested directly here,
 * leaving `PriceChart.tsx` a thin shell over these functions.
 */
import { describe, expect, it } from 'vitest'

import type { Candle, CrossSignal } from '../../api/types.ts'
import { toCandleSeries, toChartTime, toLineSeries, toMarkers } from './chartData.ts'

/** 일봉 캔들 하나 / One daily candle */
const DAILY: Candle = {
  time: '2026-07-31',
  open: 190.5,
  high: 196,
  low: 189.25,
  close: 195,
  volume: 41_200_000,
}

/** 1w 기간의 시간봉 캔들 — 백엔드가 `YYYY-MM-DDTHH:MM`을 준다 / An hourly candle from the 1w window */
const HOURLY: Candle = {
  time: '2026-07-31T14:30',
  open: 194,
  high: 195.5,
  low: 193.5,
  close: 195,
  volume: 1_200_000,
}

/** 상승/하락 마커 색 — 실제 값은 PriceChart가 토큰에서 읽는다 / Marker colours; PriceChart reads the real ones from the tokens */
const COLORS = { golden: '#F5445A', dead: '#4391FF' }

describe('toChartTime', () => {
  it('일봉 라벨은 그대로 둔다 (BusinessDay 문자열) / leaves a daily label alone, as a BusinessDay string', () => {
    expect(toChartTime('2026-07-31')).toBe('2026-07-31')
  })

  /*
   * lightweight-charts v4는 문자열 시각을 `^\d\d\d\d-\d\d-\d\d$`로만 받는다 — 개발 빌드는 그 외 문자열에
   * throw하고, 프로덕션 빌드는 시각 부분을 조용히 버려 같은 날 캔들들이 중복 시각으로 뭉친다.
   * 그래서 1w(시간봉)는 UTCTimestamp(초)로 바꿔야 한다. naive 문자열은 UTC로 해석한다 —
   * 라이브러리가 UTCTimestamp 라벨을 UTC로 찍으므로 축 라벨이 백엔드 문자열과 정확히 같아진다.
   * lightweight-charts v4 accepts a string time only as `^\d\d\d\d-\d\d-\d\d$`: the development build
   * throws on anything else and the production build silently drops the clock part, collapsing a day's
   * candles onto one duplicated time. So the 1w (hourly) window must become a UTCTimestamp in seconds.
   * A naive string is read as UTC, which makes the axis label match the backend string exactly.
   */
  it('시간봉 라벨은 UTC 초 타임스탬프로 바꾼다 / converts an intraday label into a UTC second timestamp', () => {
    expect(toChartTime('2026-07-31T14:30')).toBe(1_785_508_200)
  })

  it('해석 불가한 라벨은 null이다 (호출부가 그 점을 버린다) / an unparseable label is null, and callers drop that point', () => {
    expect(toChartTime('2026-13-99T99:99')).toBeNull()
    expect(toChartTime('')).toBeNull()
  })
})

describe('toCandleSeries', () => {
  it('캔들을 OHLC로 매핑하고 시각 라벨을 유지한다 / maps a candle to OHLC and keeps its time label', () => {
    expect(toCandleSeries([DAILY])).toEqual([
      { time: '2026-07-31', open: 190.5, high: 196, low: 189.25, close: 195 },
    ])
  })

  it('시간봉 캔들의 시각은 타임스탬프가 된다 / an hourly candle carries a timestamp', () => {
    expect(toCandleSeries([HOURLY])[0]!.time).toBe(1_785_508_200)
  })

  it('빈 배열은 빈 배열이다 / an empty input yields an empty output', () => {
    expect(toCandleSeries([])).toEqual([])
  })

  it('시각을 해석할 수 없는 캔들은 버린다 / drops a candle whose time cannot be read', () => {
    expect(toCandleSeries([{ ...DAILY, time: 'oops' }, DAILY])).toHaveLength(1)
  })
})

describe('toLineSeries', () => {
  /*
   * 백엔드 MA는 candles와 같은 길이이고 워밍업 구간이 null이다 (ma5는 앞 4개, ma20은 앞 19개).
   * 라인 시리즈는 null을 받을 수 없으므로 그 점을 제거한다 — 남은 점은 각자 자기 시각을 갖는다.
   * The backend's MAs are as long as candles with a null warm-up region (four for ma5, nineteen for
   * ma20). A line series cannot take null, so those points are removed; each survivor keeps its own time.
   */
  it('null MA 포인트를 제거하고 나머지는 시각과 짝을 유지한다 / removes null MA points and keeps the rest paired with their times', () => {
    const times = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31']
    const ma5 = [null, null, null, null, 193.4]

    expect(toLineSeries(times, ma5)).toEqual([{ time: '2026-07-31', value: 193.4 }])
  })

  it('중간이 비어도 앞뒤 점을 살린다 / keeps the points around a hole', () => {
    const times = ['2026-07-29', '2026-07-30', '2026-07-31']

    expect(toLineSeries(times, [1, null, 3])).toEqual([
      { time: '2026-07-29', value: 1 },
      { time: '2026-07-31', value: 3 },
    ])
  })

  it('전부 null이면 빈 배열이다 (MA 윈도우보다 이력이 짧은 경우) / all-null yields an empty series, as when the history is shorter than the MA window', () => {
    expect(toLineSeries(['2026-07-30', '2026-07-31'], [null, null])).toEqual([])
  })

  it('길이가 어긋나면 짧은 쪽에서 멈춘다 / stops at the shorter side when the lengths disagree', () => {
    expect(toLineSeries(['2026-07-30'], [1, 2, 3])).toEqual([{ time: '2026-07-30', value: 1 }])
    expect(toLineSeries(['2026-07-30', '2026-07-31'], [1])).toEqual([
      { time: '2026-07-30', value: 1 },
    ])
  })

  it('빈 배열은 빈 배열이다 / an empty input yields an empty output', () => {
    expect(toLineSeries([], [])).toEqual([])
  })
})

describe('toMarkers', () => {
  it('골든 크로스는 캔들 아래 상승색 화살표다 / a golden cross is an up arrow below the bar in the up colour', () => {
    const signals: CrossSignal[] = [{ time: '2026-07-31', kind: 'golden' }]

    expect(toMarkers(signals, COLORS)).toEqual([
      { time: '2026-07-31', position: 'belowBar', shape: 'arrowUp', color: '#F5445A' },
    ])
  })

  it('데드 크로스는 캔들 위 하락색 화살표다 / a dead cross is a down arrow above the bar in the down colour', () => {
    const signals: CrossSignal[] = [{ time: '2026-07-30', kind: 'dead' }]

    expect(toMarkers(signals, COLORS)).toEqual([
      { time: '2026-07-30', position: 'aboveBar', shape: 'arrowDown', color: '#4391FF' },
    ])
  })

  it('신호가 없으면 빈 배열이다 / no signals yields an empty array', () => {
    expect(toMarkers([], COLORS)).toEqual([])
  })

  it('시간봉 신호의 시각도 타임스탬프가 된다 / an intraday signal carries a timestamp too', () => {
    expect(toMarkers([{ time: '2026-07-31T14:30', kind: 'golden' }], COLORS)[0]!.time).toBe(
      1_785_508_200,
    )
  })

  it('시각을 해석할 수 없는 신호는 버린다 / drops a signal whose time cannot be read', () => {
    expect(toMarkers([{ time: 'oops', kind: 'dead' }], COLORS)).toEqual([])
  })
})
