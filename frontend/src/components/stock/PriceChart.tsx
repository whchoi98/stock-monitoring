/**
 * 가격 차트 (PRICE ACTION) — 캔들 + MA5/MA20 + 볼린저 밴드 + 거래량 + 골든/데드 크로스 마커 + 기준선(전일·52주 고/저),
 * 그리고 메인 차트에 시간축이 동기화된 RSI(14)·MACD(12,26,9) 보조 패널. 기간 탭(1W…5Y), 지표 토글, 캔들/표 뷰 전환,
 * 크로스헤어가 가리키는 캔들의 OHLC 레전드를 갖는다.
 * The price chart: candles, MA5/MA20, Bollinger Bands, volume, golden/dead cross markers, reference levels (previous
 * close, 52-week high/low), plus RSI(14) and MACD(12,26,9) sub-panes whose time scales follow the main chart. It has
 * period tabs (1W…5Y), indicator toggles, a candle/table view switch and an OHLC legend for the hovered candle.
 *
 * **색 예외 (계획이 승인한 유일한 예외)**: lightweight-charts 옵션은 canvas에 그리므로 CSS 변수를 받지 못한다. 그래서 이
 * 컴포넌트만 `getComputedStyle`로 토큰 값을 읽어 넘긴다. 하드코딩된 색은 없고, 읽는 이름은 전부 tokens.css의 변수다. 테마
 * 토글은 `<html data-theme>`만 바꾸므로 그 속성을 MutationObserver로 관찰해 테마가 바뀌면 차트를 다시 만든다.
 * **Colour exception, the only one the plan sanctions**: lightweight-charts paints onto a canvas and cannot take CSS
 * variables, so this component alone reads the token values through `getComputedStyle`. The theme toggle only flips
 * `<html data-theme>`, so that attribute is watched and the chart rebuilt on a change.
 *
 * **보조 패널은 별도 차트다** — lightweight-charts v4는 단일 패널이라, RSI/MACD는 각자 `createChart`로 만들고 메인과
 * `subscribeVisibleLogicalRangeChange`로 양방향 동기화한다. 가격축 최소 폭을 같게 두어 x축이 정확히 겹친다.
 * **The sub-panes are separate charts**: lightweight-charts v4 is single-pane, so RSI/MACD each get their own
 * `createChart`, linked to the main chart two ways through `subscribeVisibleLogicalRangeChange`; an equal minimum
 * price-axis width keeps the x axes aligned.
 *
 * 데이터 변환은 `chartData.ts`, 지표 계산은 `indicators.ts`의 순수 함수가 맡고(jsdom에서 차트는 못 돌지만 그 함수들은
 * 테스트된다), 이 파일은 차트 수명주기만 다룬다: 생성/파괴는 마운트·테마·표시여부에서만, 폴링 갱신은 `setData`로, 토글은
 * `applyOptions({visible})` 또는 패널 생성/파괴로.
 * The transforms live in `chartData.ts` and the indicator maths in `indicators.ts` as pure, tested functions; this file
 * owns only the lifecycle.
 */
import { useQueryClient } from '@tanstack/react-query'
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  LogicalRange,
  MouseEventParams,
  Time,
} from 'lightweight-charts'
import { createChart, LineStyle } from 'lightweight-charts'
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'

import { useChart } from '../../api/queries.ts'
import type { ChartData, ChartPeriod } from '../../api/types.ts'
import {
  arrow,
  changeClass,
  formatChange,
  formatPct,
  formatPrice,
  formatVolume,
  type Currency,
} from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { CandleTable } from './CandleTable.tsx'
import {
  priceFormatFor,
  toCandleSeries,
  toChartTime,
  toLineSeries,
  toLineSeriesWithGaps,
  toMarkers,
} from './chartData.ts'
import { bollingerBands, macd, rsi, summarizeCandle } from './indicators.ts'

/** 기간 탭 — 라벨은 대문자 관례, 값은 백엔드 `ChartPeriod` / The period tabs; uppercase labels over the backend's `ChartPeriod` */
const PERIODS: { value: ChartPeriod; label: string }[] = [
  { value: '1w', label: '1W' },
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: '1y', label: '1Y' },
  { value: '5y', label: '5Y' },
]

/** 기본 기간 — 한 달이 일봉 차트의 기본 시야다 / The default window; a month is the natural default for daily candles */
const DEFAULT_PERIOD: ChartPeriod = '1m'

type IndicatorKey = 'ma5' | 'ma20' | 'boll' | 'vol' | 'lvl' | 'rsi' | 'macd'

/** 지표 토글 — `dot`은 시리즈 색 토큰을 가리키는 CSS 변수 / The indicator toggles; `dot` names the series-colour token */
const INDICATORS: { key: IndicatorKey; label: string; dot?: string }[] = [
  { key: 'ma5', label: 'MA5', dot: 'var(--chart-ma5)' },
  { key: 'ma20', label: 'MA20', dot: 'var(--chart-ma20)' },
  { key: 'boll', label: 'BOLL', dot: 'var(--chart-band)' },
  { key: 'vol', label: 'VOL' },
  { key: 'lvl', label: 'LVL' },
  { key: 'rsi', label: 'RSI' },
  { key: 'macd', label: 'MACD' },
]

/** 기본 표시 — 볼린저·보조 패널은 끄고 시작한다 (기본 화면을 어지럽히지 않게) / Defaults; Bollinger and the sub-panes start off */
const DEFAULT_VISIBLE: Record<IndicatorKey, boolean> = {
  ma5: true,
  ma20: true,
  boll: false,
  vol: true,
  lvl: true,
  rsi: false,
  macd: false,
}

type View = 'candle' | 'table'

const VIEWS: { value: View; label: string }[] = [
  { value: 'candle', label: '캔들' },
  { value: 'table', label: '표' },
]

/** 거래량 히스토그램이 차지하는 아래쪽 비율 (스펙: 하단 20%) / The share of the pane the volume takes (spec: the bottom 20%) */
const VOLUME_SHARE = 0.2

/** 캔들이 거래량 띠를 침범하지 않도록 두는 여유 / The gap that keeps the candles clear of the volume band */
const PRICE_BOTTOM_MARGIN = VOLUME_SHARE + 0.06

/**
 * 가격축 최소 폭 — 메인과 보조 패널이 같은 값을 쓰므로 x축이 정확히 겹친다 (라벨 폭이 달라도).
 * The minimum price-axis width; the main chart and the sub-panes share it, so their x axes coincide whatever the labels.
 */
const PRICE_AXIS_WIDTH = 80

const RSI_PERIOD = 14

/**
 * 보조 패널이 완전한 값을 갖기 위한 최소 캔들 수 — 모자라면 패널 위에 안내를 띄운다. RSI는 첫 값이 index 14(15개), MACD는
 * 시그널·히스토그램의 첫 값이 index 25+8=33(34개)이다 (`indicators.test.ts`가 고정한다).
 * Minimum candles for a sub-pane to hold complete values; below that a notice overlays the pane. RSI's first value is at
 * index 14 (15 candles); MACD's signal and histogram first appear at index 25+8=33 (34 candles), as pinned by
 * `indicators.test.ts`.
 */
const RSI_MIN_CANDLES = RSI_PERIOD + 1
const MACD_MIN_CANDLES = 26 + 9 - 1

/** 차트에 넘길 스타일 값 — 전부 CSS 토큰에서 읽는다 / The style values handed to the chart, all read from CSS tokens */
interface ChartStyles {
  up: string
  down: string
  ma5: string
  ma20: string
  band: string
  volumeUp: string
  volumeDown: string
  text: string
  textStrong: string
  grid: string
  crosshair: string
  background: string
  fontFamily: string
}

/**
 * 현재 테마의 토큰 값을 읽는다 — 계획이 승인한 색 예외의 전부다 (파일 머리 주석 참조).
 * Read the current theme's token values; this is the whole of the sanctioned colour exception.
 */
function readStyles(): ChartStyles {
  const root = getComputedStyle(document.documentElement)
  const token = (name: string) => root.getPropertyValue(name).trim()
  return {
    up: token('--up'),
    down: token('--down'),
    ma5: token('--chart-ma5'),
    ma20: token('--chart-ma20'),
    band: token('--chart-band'),
    volumeUp: token('--chart-vol-up'),
    volumeDown: token('--chart-vol-down'),
    text: token('--text-dim'),
    textStrong: token('--text-strong'),
    grid: token('--border'),
    crosshair: token('--border-strong'),
    background: token('--panel'),
    // 축 글꼴 — canvas는 CSS를 상속하지 않으므로 고정폭 토큰을 읽어 넘긴다 / Axis font: a canvas inherits no CSS, so the mono token is passed in
    fontFamily: token('--font-mono') || getComputedStyle(document.body).fontFamily,
  }
}

/**
 * 라이브러리 시각을 인덱스 맵의 키로 — 일봉은 문자열, 시간봉은 UTCTimestamp(숫자), BusinessDay 객체도 같은 문자열로 접는다.
 * A library time as the key of the index map: daily bars are strings, intraday UTCTimestamps, and a BusinessDay object
 * folds to the same string.
 */
function timeKey(time: Time): string {
  if (typeof time === 'string') return time
  if (typeof time === 'number') return String(time)
  const month = String(time.month).padStart(2, '0')
  const day = String(time.day).padStart(2, '0')
  return `${time.year}-${month}-${day}`
}

/** `<html data-theme>`를 관찰한다 — 값이 바뀌면 차트를 다시 만든다 / Watch `<html data-theme>`; a change rebuilds the chart */
function useThemeAttribute(): string {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '')

  useEffect(() => {
    const read = () => setTheme(document.documentElement.dataset.theme ?? '')
    // 첫 렌더와 관찰 시작 사이에 바뀐 값을 따라잡는다 / Catch a change made between the first render and here
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return theme
}

/** 한 번 만들어 함께 파괴되는 메인 차트 한 벌 / The main chart and the series that live and die with it */
interface ChartHandle {
  chart: IChartApi
  candles: ISeriesApi<'Candlestick'>
  ma5: ISeriesApi<'Line'>
  ma20: ISeriesApi<'Line'>
  bollUpper: ISeriesApi<'Line'>
  bollLower: ISeriesApi<'Line'>
  volume: ISeriesApi<'Histogram'>
  styles: ChartStyles
}

/**
 * 보조 패널 한 벌 — `series`는 크로스헤어 동기화가 가로선을 앉힐 시리즈, `values`는 시각 키 → 그 시리즈의 값.
 * One sub-pane: `series` is where crosshair sync places the horizontal line, `values` maps a time key to that series' value.
 */
interface RsiPane {
  chart: IChartApi
  series: ISeriesApi<'Line'>
  values: Map<string, number>
  unlink: () => void
}

interface MacdPane {
  chart: IChartApi
  histogram: ISeriesApi<'Histogram'>
  line: ISeriesApi<'Line'>
  signal: ISeriesApi<'Line'>
  /** = `line` — 크로스헤어 가로선은 MACD 선을 따른다 / The MACD line, which the crosshair's horizontal line follows */
  series: ISeriesApi<'Line'>
  values: Map<string, number>
  unlink: () => void
}

/** 시각 키 → 값 (크로스헤어 동기화가 가로선 위치를 잡는 데 쓴다) / Time key to value, so crosshair sync can place the horizontal line */
function valuesByTime(times: string[], values: (number | null)[]): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < times.length; i += 1) {
    const value = values[i]
    const time = toChartTime(times[i]!)
    if (value !== null && value !== undefined && time !== null) map.set(timeKey(time), value)
  }
  return map
}

/**
 * 보조 패널 차트 — 메인과 같은 토큰, 시간축 라벨은 숨긴다(메인이 보여준다). 가격축 최소 폭은 메인과 같다.
 * A sub-pane chart: the main chart's tokens, the time labels hidden (the main shows them), the same minimum axis width.
 */
function createPaneChart(container: HTMLElement, styles: ChartStyles): IChartApi {
  return createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { color: styles.background },
      textColor: styles.text,
      fontFamily: styles.fontFamily,
      fontSize: 10,
    },
    grid: { vertLines: { color: styles.grid }, horzLines: { color: styles.grid } },
    crosshair: {
      vertLine: { color: styles.crosshair, labelBackgroundColor: styles.crosshair },
      /*
       * 가로선은 숨긴다 — 동기화된 크로스헤어는 시각(세로선)만 의미가 있고, 워밍업 구간(값 없음)에서도 세로선이 따라가야
       * 한다. `setCrosshairPosition`에 넘기는 가격은 그래서 자리 표시자일 뿐이다.
       * The horizontal line is hidden: a synced crosshair carries meaning only through time (the vertical line), and it
       * must follow into the warm-up region too, where there is no value — so the price handed to `setCrosshairPosition`
       * is merely a placeholder.
       */
      horzLine: { visible: false, labelVisible: false },
    },
    rightPriceScale: {
      borderColor: styles.grid,
      minimumWidth: PRICE_AXIS_WIDTH,
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
    timeScale: { visible: false, borderColor: styles.grid },
    localization: { locale: 'ko-KR' },
  })
}

/**
 * 두 차트의 시간축을 양방향으로 잇는다 — 재진입 가드로 서로를 무한히 깨우지 않는다.
 * Link two charts' time scales both ways, with a re-entrancy guard so they never wake each other forever.
 */
function linkTimeScales(main: IChartApi, pane: IChartApi): () => void {
  let syncing = false
  const forward = (from: IChartApi, to: IChartApi) => (range: LogicalRange | null) => {
    if (syncing || range === null) return
    syncing = true
    to.timeScale().setVisibleLogicalRange(range)
    syncing = false
    void from
  }
  const onMain = forward(main, pane)
  const onPane = forward(pane, main)
  main.timeScale().subscribeVisibleLogicalRangeChange(onMain)
  pane.timeScale().subscribeVisibleLogicalRangeChange(onPane)
  return () => {
    main.timeScale().unsubscribeVisibleLogicalRangeChange(onMain)
    pane.timeScale().unsubscribeVisibleLogicalRangeChange(onPane)
  }
}

/**
 * 크로스헤어를 놓되 라이브러리 단언을 삼킨다 — `setCrosshairPosition`은 값이 하나도 없는 차트(가격축 기준값 null)나 시간축에
 * 없는 시각에서 "Value is null"을 던진다. 동기화는 장식이므로 실패해도 그 차트의 크로스헤어만 지운다.
 * Place the crosshair, swallowing the library's assertion: `setCrosshairPosition` throws "Value is null" on a chart with
 * no values (null first value on its price scale) or a time missing from its scale. Sync is decoration, so a failure only
 * clears that chart's crosshair.
 */
function placeCrosshair(chart: IChartApi, price: number, time: Time, series: ISeriesApi<'Line' | 'Candlestick'>): void {
  try {
    chart.setCrosshairPosition(price, time, series)
  } catch {
    chart.clearCrosshairPosition()
  }
}

/** 메인의 현재 시야를 보조 패널에 맞춘다 (데이터를 넣은 직후) / Match the pane to the main chart's current range (right after data) */
function syncRange(main: IChartApi, pane: IChartApi): void {
  const range = main.timeScale().getVisibleLogicalRange()
  if (range !== null) pane.timeScale().setVisibleLogicalRange(range)
}

function fillRsi(pane: RsiPane, main: IChartApi, data: ChartData): void {
  const times = data.candles.map((candle) => candle.time)
  const values = rsi(data.candles.map((candle) => candle.close), RSI_PERIOD)
  // 워밍업 구간은 공백 포인트로 — 패널의 논리 인덱스가 메인의 캔들 인덱스와 1:1이어야 한다 / Warm-up as whitespace: the pane's logical index must match the main chart's
  pane.series.setData(toLineSeriesWithGaps(times, values))
  pane.values = valuesByTime(times, values)
  syncRange(main, pane.chart)
}

function fillMacd(pane: MacdPane, main: IChartApi, data: ChartData, styles: ChartStyles): void {
  const times = data.candles.map((candle) => candle.time)
  const out = macd(data.candles.map((candle) => candle.close))
  pane.line.setData(toLineSeriesWithGaps(times, out.macd))
  pane.values = valuesByTime(times, out.macd)
  pane.signal.setData(toLineSeriesWithGaps(times, out.signal))
  pane.histogram.setData(
    times.flatMap((time, index) => {
      const chartTime = toChartTime(time)
      if (chartTime === null) return []
      const value = out.histogram[index]
      // 워밍업 구간은 공백 포인트 / Warm-up as whitespace
      if (value === null || value === undefined) return [{ time: chartTime }]
      return [{ time: chartTime, value, color: value >= 0 ? styles.volumeUp : styles.volumeDown }]
    }),
  )
  syncRange(main, pane.chart)
}

/** 기준선 — 상세 화면이 넘겨준다 (0 센티널은 그리지 않는다) / Reference levels handed in by the detail screen (0 sentinels are skipped) */
export interface ChartLevels {
  prevClose?: number
  week52High?: number
  week52Low?: number
}

export interface PriceChartProps {
  /** 종목 심볼 — 그대로 훅에 넘긴다 / The symbol, handed straight to the hook */
  symbol: string
  /**
   * 가격축 통화 — KRW면 소수점을 없앤다 (`priceFormatFor`). 차트 엔드포인트는 통화를 담지 않으므로 통화를 아는 화면이
   * 넘겨준다. 심볼 접미사로 추측하지 않는다.
   * The price axis's currency; the chart endpoint carries none, so the screen that knows it passes it in.
   */
  currency?: Currency
  /** 기준선 (전일종가·52주 고/저) / Reference levels (previous close, 52-week high/low) */
  levels?: ChartLevels
  /** 시작 뷰 — 기본은 캔들 / The initial view; candles by default */
  defaultView?: View
}

function LegendItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="legend-item">
      <span className="legend-key">{label}</span>
      <span className="legend-value">{value}</span>
    </span>
  )
}

export function PriceChart({ symbol, currency, levels, defaultView = 'candle' }: PriceChartProps) {
  const [period, setPeriod] = useState<ChartPeriod>(DEFAULT_PERIOD)
  const [visible, setVisible] = useState<Record<IndicatorKey, boolean>>(DEFAULT_VISIBLE)
  const [view, setView] = useState<View>(defaultView)
  /** 크로스헤어가 가리키는 캔들 인덱스 — 차트 밖이면 null (레전드는 마지막 캔들로) / The hovered candle's index; null off-chart */
  const [hover, setHover] = useState<number | null>(null)
  const { data, asOf, isLoading, error } = useChart(symbol, period)
  const theme = useThemeAttribute()
  const queryClient = useQueryClient()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const rsiRef = useRef<HTMLDivElement | null>(null)
  const macdRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<ChartHandle | null>(null)
  const rsiPaneRef = useRef<RsiPane | null>(null)
  const macdPaneRef = useRef<MacdPane | null>(null)
  /** 최신 데이터 — 보조 패널이 생길 때 바로 채우기 위해 / The latest data, so a new pane can fill itself at once */
  const dataRef = useRef<ChartData | undefined>(undefined)
  dataRef.current = data
  /*
   * 마지막으로 시야를 맞춘 데이터의 표식 — 45초 폴링마다 `fitContent()`를 부르면 사용자의 확대/이동이 되돌아간다.
   * A tag for the data the viewport was last fitted to: refit only when the symbol, period or candle count changes.
   */
  const fittedRef = useRef<string | null>(null)
  /** 시각 키 → 캔들 인덱스 (크로스헤어 → 레전드) / Time key to candle index (crosshair to legend) */
  const timeIndexRef = useRef<Map<string, number>>(new Map())
  /** 현재 그려진 기준선 / The reference lines currently drawn */
  const levelLinesRef = useRef<IPriceLine[]>([])

  // 재시도는 이 위젯의 쿼리 키만 무효화한다 — `api/queries.ts`의 `['chart', symbol, period]` / The retry invalidates just this key
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['chart', symbol, period] })
  }

  /** 크로스헤어 동기화 재진입 가드 — 한 차트의 `setCrosshairPosition`이 그 차트의 이벤트를 다시 부르지 않게 / Re-entrancy guard for crosshair sync */
  const syncingRef = useRef(false)

  /*
   * 크로스헤어 방송 — 어느 차트(메인·RSI·MACD)에서 움직였든 레전드를 갱신하고 나머지 차트의 크로스헤어를 같은 시각에
   * 놓는다 (`setCrosshairPosition`, 가로선은 그 차트 시리즈의 해당 시각 값). 차트 밖으로 나가면 모두 지운다. ref만 읽으므로
   * 이펙트가 잡은 클로저가 낡지 않는다.
   * Broadcast the crosshair: whichever chart (main, RSI, MACD) moved, refresh the legend and put the other charts'
   * crosshairs at the same time (`setCrosshairPosition`; the horizontal line sits on that chart's series value at that
   * time). Leaving a chart clears them all. It reads refs only, so the closure an effect captured never goes stale.
   */
  const broadcastCrosshair = useCallback((source: 'main' | 'rsi' | 'macd', param: MouseEventParams) => {
    if (syncingRef.current) return
    syncingRef.current = true
    try {
      const key = param.time === undefined ? null : timeKey(param.time)
      const index = key === null ? undefined : timeIndexRef.current.get(key)
      setHover(index ?? null)

      const main = handleRef.current
      if (main !== null && source !== 'main') {
        const candle = index === undefined ? undefined : dataRef.current?.candles[index]
        if (param.time === undefined || candle === undefined) main.chart.clearCrosshairPosition()
        else placeCrosshair(main.chart, candle.close, param.time, main.candles)
      }

      const panes: Array<['rsi' | 'macd', RsiPane | MacdPane | null]> = [
        ['rsi', rsiPaneRef.current],
        ['macd', macdPaneRef.current],
      ]
      for (const [name, pane] of panes) {
        if (pane === null || name === source) continue
        // 값이 하나도 없는 패널(짧은 기간의 MACD)은 가격축 기준값이 없어 크로스헤어를 놓을 수 없다 / A pane with no values (MACD on a short window) has no price-scale anchor
        if (param.time === undefined || index === undefined || pane.values.size === 0) {
          pane.chart.clearCrosshairPosition()
          continue
        }
        // 가로선은 숨겨져 있으므로 값이 없는 슬롯(워밍업)에서는 자리 표시자 0으로 세로선만 세운다 / With the horizontal line hidden, a value-less slot uses 0 as a placeholder
        placeCrosshair(pane.chart, pane.values.get(key ?? '') ?? 0, param.time, pane.series)
      }
    } finally {
      syncingRef.current = false
    }
  }, [])

  const hasCandles = data !== undefined && data.candles.length > 0
  /** 차트 컨테이너를 렌더하는 조건 — 아래 생성 이펙트의 전제다 / When the container is rendered, which the create effects depend on */
  const showChart = error === null && !isLoading && hasCandles && view === 'candle'

  /*
   * 메인 차트 생성/파괴 — 컨테이너가 생겼을 때와 테마가 바뀔 때만. 데이터 폴링으로는 다시 만들지 않는다.
   * Create and destroy the main chart only when the container appears and when the theme changes; a poll never rebuilds it.
   */
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    const styles = readStyles()
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      /*
       * `attributionLogo`는 기본값(true)을 그대로 둔다 — 끄지 말 것.
       * lightweight-charts 라이선스는 TradingView를 제작자로 밝히고 https://www.tradingview.com/ 링크를 사용자에게 보이는
       * 화면에 두라고 요구하며, 이 옵션이 그 링크 요구를 충족시키는 공식 수단이다. 보조 패널도 같은 이유로 그대로 둔다.
       * Leave `attributionLogo` at its default (true) — do not switch it off. The lightweight-charts licence requires a
       * TradingView credit and a link to https://www.tradingview.com/ on a user-visible page, and this option is the
       * official way to satisfy it. The sub-panes keep it too, for the same reason.
       */
      layout: {
        background: { color: styles.background },
        textColor: styles.text,
        fontFamily: styles.fontFamily,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: styles.grid },
        horzLines: { color: styles.grid },
      },
      crosshair: {
        vertLine: { color: styles.crosshair, labelBackgroundColor: styles.crosshair },
        horzLine: { color: styles.crosshair, labelBackgroundColor: styles.crosshair },
      },
      rightPriceScale: {
        borderColor: styles.grid,
        minimumWidth: PRICE_AXIS_WIDTH,
        // 아래쪽은 거래량 띠에 넘겨준다 / The lower band belongs to the volume
        scaleMargins: { top: 0.08, bottom: PRICE_BOTTOM_MARGIN },
      },
      timeScale: { borderColor: styles.grid },
      /*
       * 축 날짜 로케일을 고정한다 — 기본값 `navigator.language`가 규격 밖 태그면 라이브러리의 `toLocaleString`이 RangeError로
       * 죽어 시간축 라벨이 조용히 사라진다.
       * Pin the axis locale: a non-spec `navigator.language` makes the library's `toLocaleString` throw and silently erases
       * the time-axis labels.
       */
      localization: { locale: 'ko-KR' },
    })

    // `priceFormat`은 시리즈 생성 시에만 정해지므로 통화가 이 이펙트의 의존성에 들어간다 / `priceFormat` is fixed at creation, so the currency is a dependency
    const priceFormat = priceFormatFor(currency)
    const candles = chart.addCandlestickSeries({
      upColor: styles.up,
      downColor: styles.down,
      borderUpColor: styles.up,
      borderDownColor: styles.down,
      wickUpColor: styles.up,
      wickDownColor: styles.down,
      ...(priceFormat === undefined ? {} : { priceFormat }),
    })

    /** 보조선 — 가격축 라벨/기준선을 만들지 않는다 / Overlays: no axis label, no price line */
    const line = (color: string, lineStyle: LineStyle = LineStyle.Solid) => ({
      color,
      lineWidth: 1 as const,
      lineStyle,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    const ma5 = chart.addLineSeries(line(styles.ma5))
    const ma20 = chart.addLineSeries(line(styles.ma20))
    const bollUpper = chart.addLineSeries(line(styles.band, LineStyle.Dashed))
    const bollLower = chart.addLineSeries(line(styles.band, LineStyle.Dashed))

    /*
     * 거래량은 자기만의 오버레이 가격축(`priceScaleId: ''`)에 올리고 그 축을 아래 20%로 밀어 가격 스케일과 섞이지 않게 한다.
     * 막대 색은 캔들 방향을 따른다 (데이터 이펙트에서 점마다 지정).
     * The volume sits on its own overlay price scale, pushed into the bottom 20%; each bar's colour follows its candle.
     */
    const volume = chart.addHistogramSeries({
      color: styles.volumeUp,
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 1 - VOLUME_SHARE, bottom: 0 } })

    // 크로스헤어 → 레전드 + 보조 패널 동기화. 차트 밖(time 없음)이면 레전드는 마지막 캔들로, 패널은 지운다 / Crosshair to legend and sub-panes; off-chart falls back
    const onCrosshair = (param: MouseEventParams) => broadcastCrosshair('main', param)
    chart.subscribeCrosshairMove(onCrosshair)

    handleRef.current = { chart, candles, ma5, ma20, bollUpper, bollLower, volume, styles }
    fittedRef.current = null
    // 이전 차트의 기준선은 그 시리즈와 함께 죽었다 / The previous chart's reference lines died with its series
    levelLinesRef.current = []

    // 패널 폭이 바뀌면 캔버스도 따라가야 한다 (높이는 CSS가 정한다) / The canvas follows the panel's width; CSS owns the height
    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      chart.unsubscribeCrosshairMove(onCrosshair)
      chart.remove()
      handleRef.current = null
    }
  }, [showChart, theme, currency, broadcastCrosshair])

  /*
   * RSI 보조 패널 — 토글이 켜져 컨테이너가 생기면 만들고, 메인과 시간축을 잇고, 최신 데이터로 바로 채운다.
   * 메인 생성 이펙트가 위에 선언되어 있으므로 테마 변경 시에도 (메인 재생성 → 이 패널 재생성) 순서가 보장된다.
   * The RSI pane: created when its toggle renders the container, linked to the main chart and filled from the latest data
   * at once. Declared after the main create effect, so a theme change rebuilds the main chart first.
   */
  useEffect(() => {
    const container = rsiRef.current
    const main = handleRef.current
    if (container === null || main === null) return

    const chart = createPaneChart(container, main.styles)
    const line = chart.addLineSeries({
      color: main.styles.textStrong,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      // RSI는 0~100에 고정한다 — 자동 스케일이면 30/70 기준선의 의미가 흔들린다 / Pin RSI to 0–100; autoscale would unmoor the 30/70 lines
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    })
    for (const level of [70, 30]) {
      line.createPriceLine({
        price: level,
        color: main.styles.text,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: '',
      })
    }
    const pane: RsiPane = { chart, series: line, values: new Map(), unlink: linkTimeScales(main.chart, chart) }
    rsiPaneRef.current = pane
    if (dataRef.current !== undefined) fillRsi(pane, main.chart, dataRef.current)
    // 패널 위의 크로스헤어도 메인·다른 패널로 방송한다 / A crosshair on this pane broadcasts to the main chart and the other pane
    const onCrosshair = (param: MouseEventParams) => broadcastCrosshair('rsi', param)
    chart.subscribeCrosshairMove(onCrosshair)

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      chart.unsubscribeCrosshairMove(onCrosshair)
      pane.unlink()
      chart.remove()
      rsiPaneRef.current = null
    }
  }, [visible.rsi, showChart, theme, currency, broadcastCrosshair])

  /* MACD 보조 패널 — RSI와 같은 수명주기 / The MACD pane, same lifecycle as RSI */
  useEffect(() => {
    const container = macdRef.current
    const main = handleRef.current
    if (container === null || main === null) return

    const chart = createPaneChart(container, main.styles)
    const histogram = chart.addHistogramSeries({
      color: main.styles.volumeUp,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    const line = chart.addLineSeries({
      color: main.styles.ma5,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    })
    const signal = chart.addLineSeries({
      color: main.styles.ma20,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    const pane: MacdPane = {
      chart,
      histogram,
      line,
      signal,
      series: line,
      values: new Map(),
      unlink: linkTimeScales(main.chart, chart),
    }
    macdPaneRef.current = pane
    if (dataRef.current !== undefined) fillMacd(pane, main.chart, dataRef.current, main.styles)
    const onCrosshair = (param: MouseEventParams) => broadcastCrosshair('macd', param)
    chart.subscribeCrosshairMove(onCrosshair)

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      chart.unsubscribeCrosshairMove(onCrosshair)
      pane.unlink()
      chart.remove()
      macdPaneRef.current = null
    }
  }, [visible.macd, showChart, theme, currency, broadcastCrosshair])

  /*
   * 데이터 반영 — 폴링·기간 변경은 `setData`로만 처리한다. 보조 패널이 있으면 함께 채운다.
   * Push the data in; a poll or a period change only ever calls `setData`. Sub-panes present get filled too.
   */
  useEffect(() => {
    const handle = handleRef.current
    if (handle === null || data === undefined) return

    const times = data.candles.map((candle) => candle.time)
    handle.candles.setData(toCandleSeries(data.candles))
    handle.ma5.setData(toLineSeries(times, data.ma5))
    handle.ma20.setData(toLineSeries(times, data.ma20))

    // 볼린저는 백엔드가 주지 않으므로 종가에서 계산한다 (20, 2σ) / Bollinger is not sent by the backend, so it is computed from the closes
    const bands = bollingerBands(data.candles.map((candle) => candle.close))
    handle.bollUpper.setData(toLineSeries(times, bands.upper))
    handle.bollLower.setData(toLineSeries(times, bands.lower))

    handle.volume.setData(
      data.candles.flatMap((candle) => {
        const time = toChartTime(candle.time)
        if (time === null) return []
        const color = candle.close >= candle.open ? handle.styles.volumeUp : handle.styles.volumeDown
        return [{ time, value: candle.volume, color }]
      }),
    )
    handle.candles.setMarkers(
      toMarkers(data.signals, { golden: handle.styles.up, dead: handle.styles.down }),
    )

    // 크로스헤어 시각 → 인덱스 (레전드용) / Crosshair time to index, for the legend
    const index = new Map<string, number>()
    data.candles.forEach((candle, i) => {
      const time = toChartTime(candle.time)
      if (time !== null) index.set(timeKey(time), i)
    })
    timeIndexRef.current = index

    // 1w는 시간봉이라 시각까지 보여야 날짜가 반복되지 않는다 / The 1w window is hourly, so the clock must show or the dates repeat
    handle.chart
      .timeScale()
      .applyOptions({ timeVisible: times.some((time) => time.includes('T')), secondsVisible: false })

    const fitKey = `${data.symbol}:${data.period}:${data.candles.length}`
    if (fittedRef.current !== fitKey) {
      handle.chart.timeScale().fitContent()
      fittedRef.current = fitKey
    }

    if (rsiPaneRef.current !== null) fillRsi(rsiPaneRef.current, handle.chart, data)
    if (macdPaneRef.current !== null) fillMacd(macdPaneRef.current, handle.chart, data, handle.styles)
  }, [data, showChart, theme, currency])

  /*
   * 지표 토글 — 시리즈를 지우고 다시 만들지 않고 `visible`만 바꾼다 (보조 패널은 자기 이펙트가 생성/파괴한다).
   * The overlay toggles only flip `visible`, never recreate a series (the sub-panes are created/destroyed by their own effects).
   */
  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return
    handle.ma5.applyOptions({ visible: visible.ma5 })
    handle.ma20.applyOptions({ visible: visible.ma20 })
    handle.bollUpper.applyOptions({ visible: visible.boll })
    handle.bollLower.applyOptions({ visible: visible.boll })
    handle.volume.applyOptions({ visible: visible.vol })
  }, [visible, showChart, theme, currency])

  /*
   * 기준선 — 전일종가·52주 고/저. 값이 바뀌면 지우고 다시 그린다. 0 센티널(결측)은 그리지 않는다.
   * Reference levels: previous close and 52-week high/low, redrawn when a value changes; 0 sentinels (missing) are skipped.
   */
  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return
    for (const priceLine of levelLinesRef.current) handle.candles.removePriceLine(priceLine)
    levelLinesRef.current = []
    if (!visible.lvl || levels === undefined) return

    const add = (price: number | undefined, title: string, color: string) => {
      if (price === undefined || !Number.isFinite(price) || price <= 0) return
      levelLinesRef.current.push(
        handle.candles.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title,
        }),
      )
    }
    add(levels.prevClose, '전일', handle.styles.text)
    add(levels.week52High, '52H', handle.styles.up)
    add(levels.week52Low, '52L', handle.styles.down)
  }, [levels, visible.lvl, showChart, theme, currency])

  /*
   * 레전드 — 크로스헤어가 가리키는 캔들, 없으면 마지막 캔들. 캔들 수가 줄어 인덱스가 범위를 벗어나면 마지막으로 되돌린다.
   * The legend: the hovered candle, else the last one; an index left out of range by a shorter series falls back.
   */
  const legendCurrency: Currency = currency ?? 'USD'
  const summary =
    data !== undefined && data.candles.length > 0
      ? summarizeCandle(
          data.candles,
          hover !== null && hover < data.candles.length ? hover : data.candles.length - 1,
        )
      : null

  return (
    <Panel id="price-action" eyebrow="PRICE ACTION" title="가격 차트" action={<AsOfBadge asOf={asOf} />}>
      <div className="chart-toolbar">
        {/* `role="group"` + `aria-pressed` 토글 — 바뀌는 것은 canvas 하나라 tablist 모델이 맞지 않는다 / Labelled groups of pressed toggles */}
        <div className="chart-toolbar-group">
          <div className="tabs" role="group" aria-label="기간 선택">
            {PERIODS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={value === period ? 'tab tab-active' : 'tab'}
                aria-pressed={value === period}
                onClick={() => setPeriod(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="tabs" role="group" aria-label="표시 방식">
            {VIEWS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={value === view ? 'tab tab-active' : 'tab'}
                aria-pressed={value === view}
                onClick={() => setView(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="tabs" role="group" aria-label="지표 선택">
          {INDICATORS.map(({ key, label, dot }) => (
            <button
              key={key}
              type="button"
              className={visible[key] ? 'tab tab-active' : 'tab'}
              aria-pressed={visible[key]}
              onClick={() => setVisible((prev) => ({ ...prev, [key]: !prev[key] }))}
            >
              {dot !== undefined && (
                <i className="tab-dot" aria-hidden="true" style={{ '--dot': dot } as CSSProperties} />
              )}
              {label}
            </button>
          ))}
        </div>
      </div>

      {error !== null ? (
        <ErrorCard onRetry={retry} message="가격 차트를 불러오지 못했습니다" />
      ) : isLoading ? (
        <Spinner />
      ) : !hasCandles ? (
        <p className="empty">차트 데이터가 없습니다</p>
      ) : view === 'table' ? (
        <CandleTable candles={data.candles} currency={legendCurrency} />
      ) : (
        <>
          {summary !== null && (
            <div className="chart-legend">
              <LegendItem label="T" value={summary.time.replace('T', ' ')} />
              <LegendItem label="O" value={formatPrice(summary.open, legendCurrency)} />
              <LegendItem label="H" value={formatPrice(summary.high, legendCurrency)} />
              <LegendItem label="L" value={formatPrice(summary.low, legendCurrency)} />
              <LegendItem label="C" value={formatPrice(summary.close, legendCurrency)} />
              <span className="legend-item">
                <span className="legend-key">CHG</span>
                {summary.change === null ? (
                  <span className="legend-value">—</span>
                ) : (
                  <span className={`legend-value ${changeClass(summary.change)}`}>
                    {arrow(summary.change)}
                    {formatChange(summary.change, legendCurrency)}
                    {summary.changePct !== null && ` (${formatPct(summary.changePct)})`}
                  </span>
                )}
              </span>
              <LegendItem label="VOL" value={formatVolume(summary.volume)} />
            </div>
          )}
          {/* 크기는 CSS가 정한다 — lightweight-charts가 컨테이너 크기를 읽어 캔버스를 만든다 / CSS owns the size; the library reads the container's box */}
          <div className="price-chart" ref={containerRef} />
          {visible.rsi && (
            <div className="chart-pane">
              <span className="pane-label">RSI {RSI_PERIOD}</span>
              {data.candles.length < RSI_MIN_CANDLES && (
                <span className="pane-note">캔들 {RSI_MIN_CANDLES}개 이상 필요 (현재 {data.candles.length}) — 더 긴 기간을 선택하세요</span>
              )}
              <div className="pane-canvas" ref={rsiRef} />
            </div>
          )}
          {visible.macd && (
            <div className="chart-pane">
              <span className="pane-label">MACD 12·26·9</span>
              {data.candles.length < MACD_MIN_CANDLES && (
                <span className="pane-note">캔들 {MACD_MIN_CANDLES}개 이상 필요 (현재 {data.candles.length}) — 더 긴 기간을 선택하세요</span>
              )}
              <div className="pane-canvas" ref={macdRef} />
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
