/**
 * 가격 차트 (PRICE ACTION) — 캔들 + MA5/MA20 + 볼린저 밴드 + 거래량 히스토그램 + 골든/데드 크로스 마커.
 * 기간 탭(1W/1M/3M/1Y), 지표 토글(MA5/MA20/BOLL/VOL), 크로스헤어가 가리키는 캔들의 OHLC 레전드를 갖는다.
 * The price chart: candles, MA5/MA20, Bollinger Bands, a volume histogram and golden/dead cross markers, with the
 * 1W/1M/3M/1Y period tabs, the MA5/MA20/BOLL/VOL indicator toggles and an OHLC legend for the hovered candle.
 *
 * **색 예외 (계획이 승인한 유일한 예외)**: lightweight-charts 옵션은 canvas에 그리므로 CSS 변수를 받지 못한다.
 * 그래서 이 컴포넌트만 `getComputedStyle(document.documentElement).getPropertyValue('--up')`으로 토큰 값을 읽어
 * 넘긴다. 하드코딩된 색은 없고, 읽는 이름은 전부 tokens.css의 변수다. 테마 토글은 `<html data-theme>`만 바꾸므로
 * canvas는 스스로 갱신되지 않는다 — 그 속성을 MutationObserver로 관찰해 테마가 바뀌면 차트를 다시 만든다.
 * **Colour exception, the only one the plan sanctions**: lightweight-charts paints onto a canvas and cannot take
 * CSS variables, so this component alone reads the token values through `getComputedStyle`. No colour is hardcoded;
 * every name read is a tokens.css variable. The theme toggle only flips `<html data-theme>`, which a canvas cannot
 * notice, so that attribute is watched with a MutationObserver and the chart is rebuilt on a change.
 *
 * 데이터 변환은 `chartData.ts`, 지표 계산은 `indicators.ts`의 순수 함수가 맡고(jsdom에서 차트는 못 돌지만 그
 * 함수들은 테스트된다), 이 파일은 차트 수명주기만 다룬다: 생성/파괴는 마운트·테마·표시여부에서만, 폴링 갱신은
 * `setData`로, 토글은 `applyOptions({visible})`로.
 * The transforms live in `chartData.ts` and the indicator maths in `indicators.ts` as pure, tested functions; this
 * file owns only the lifecycle: create and destroy on mount, theme and visibility, a poll updates through `setData`,
 * a toggle through `applyOptions({visible})`.
 */
import { useQueryClient } from '@tanstack/react-query'
import type { IChartApi, ISeriesApi, MouseEventParams, Time } from 'lightweight-charts'
import { createChart, LineStyle } from 'lightweight-charts'
import { type CSSProperties, useEffect, useRef, useState } from 'react'

import { useChart } from '../../api/queries.ts'
import type { Period } from '../../api/types.ts'
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
import { priceFormatFor, toCandleSeries, toChartTime, toLineSeries, toMarkers } from './chartData.ts'
import { bollingerBands, summarizeCandle } from './indicators.ts'

/** 기간 탭 — 라벨은 대문자 관례, 값은 백엔드 `Period` / The period tabs; uppercase labels over the backend's `Period` */
const PERIODS: { value: Period; label: string }[] = [
  { value: '1w', label: '1W' },
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '1y', label: '1Y' },
]

/** 기본 기간 — 한 달이 일봉 차트의 기본 시야다 / The default window; a month is the natural default for daily candles */
const DEFAULT_PERIOD: Period = '1m'

type IndicatorKey = 'ma5' | 'ma20' | 'boll' | 'vol'

/** 지표 토글 — `dot`은 시리즈 색 토큰을 가리키는 CSS 변수 / The indicator toggles; `dot` names the series-colour token */
const INDICATORS: { key: IndicatorKey; label: string; dot?: string }[] = [
  { key: 'ma5', label: 'MA5', dot: 'var(--chart-ma5)' },
  { key: 'ma20', label: 'MA20', dot: 'var(--chart-ma20)' },
  { key: 'boll', label: 'BOLL', dot: 'var(--chart-band)' },
  { key: 'vol', label: 'VOL' },
]

/** 기본 표시 — 볼린저는 끄고 시작한다 (기본 화면을 어지럽히지 않게) / Defaults; Bollinger starts off so the default view stays clean */
const DEFAULT_VISIBLE: Record<IndicatorKey, boolean> = { ma5: true, ma20: true, boll: false, vol: true }

/** 거래량 히스토그램이 차지하는 아래쪽 비율 (스펙: 하단 20%) / The share of the pane the volume takes (spec: the bottom 20%) */
const VOLUME_SHARE = 0.2

/** 캔들이 거래량 띠를 침범하지 않도록 두는 여유 / The gap that keeps the candles clear of the volume band */
const PRICE_BOTTOM_MARGIN = VOLUME_SHARE + 0.06

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
    grid: token('--border'),
    crosshair: token('--border-strong'),
    background: token('--panel'),
    // 축 글꼴 — canvas는 CSS를 상속하지 않으므로 고정폭 토큰을 읽어 넘긴다 / Axis font: a canvas inherits no CSS, so the mono token is passed in
    fontFamily: token('--font-mono') || getComputedStyle(document.body).fontFamily,
  }
}

/**
 * 라이브러리 시각을 인덱스 맵의 키로 / A library time as the key of the index map.
 *
 * 일봉은 문자열(`YYYY-MM-DD`), 시간봉은 UTCTimestamp(숫자)로 넣었고, 크로스헤어 이벤트는 넣은 형식 그대로 돌려준다.
 * BusinessDay 객체로 올 가능성까지 같은 문자열로 접는다.
 * Daily bars go in as strings, intraday as UTCTimestamps, and the crosshair event echoes the format supplied; a
 * BusinessDay object folds to the same string too.
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

/** 한 번 만들어 함께 파괴되는 차트 한 벌 / One chart and the series that live and die with it */
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

export interface PriceChartProps {
  /** 종목 심볼 — 그대로 훅에 넘긴다 / The symbol, handed straight to the hook */
  symbol: string
  /**
   * 가격축 통화 — KRW면 소수점을 없앤다 (`priceFormatFor`). 생략하면 라이브러리 기본값(2자리)이 남는다.
   * 차트 엔드포인트는 통화를 담지 않으므로 통화를 아는 화면이 넘겨준다. 심볼 접미사로 추측하지 않는다.
   * The price axis's currency; KRW drops the decimals. The chart endpoint carries no currency, so the screen that
   * knows it passes it in — never guessed from the symbol's suffix.
   */
  currency?: Currency
}

function LegendItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="legend-item">
      <span className="legend-key">{label}</span>
      <span className="legend-value">{value}</span>
    </span>
  )
}

export function PriceChart({ symbol, currency }: PriceChartProps) {
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD)
  const [visible, setVisible] = useState<Record<IndicatorKey, boolean>>(DEFAULT_VISIBLE)
  /** 크로스헤어가 가리키는 캔들 인덱스 — 차트 밖이면 null (레전드는 마지막 캔들로) / The hovered candle's index; null off-chart (legend falls back to the last) */
  const [hover, setHover] = useState<number | null>(null)
  const { data, asOf, isLoading, error } = useChart(symbol, period)
  const theme = useThemeAttribute()
  const queryClient = useQueryClient()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<ChartHandle | null>(null)
  /*
   * 마지막으로 시야를 맞춘 데이터의 표식 — 45초 폴링마다 `fitContent()`를 부르면 사용자의 확대/이동이 되돌아간다.
   * 심볼·기간이 바뀌거나 캔들 개수가 달라졌을 때만 다시 맞춘다.
   * A tag for the data the viewport was last fitted to: refit only when the symbol, period or candle count changes,
   * never on a plain poll.
   */
  const fittedRef = useRef<string | null>(null)
  /** 시각 키 → 캔들 인덱스 (크로스헤어 → 레전드) / Time key to candle index (crosshair to legend) */
  const timeIndexRef = useRef<Map<string, number>>(new Map())

  // 재시도는 이 위젯의 쿼리 키만 무효화한다 — `api/queries.ts`의 `['chart', symbol, period]` / The retry invalidates just this key
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['chart', symbol, period] })
  }

  const hasCandles = data !== undefined && data.candles.length > 0
  /** 차트 컨테이너를 렌더하는 조건 — 아래 생성 이펙트의 전제다 / When the container is rendered, which the create effect depends on */
  const showChart = error === null && !isLoading && hasCandles

  /*
   * 차트 생성/파괴 — 컨테이너가 생겼을 때와 테마가 바뀔 때만. 데이터 폴링으로는 다시 만들지 않는다.
   * Create and destroy the chart only when the container appears and when the theme changes; a poll never rebuilds it.
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
       * lightweight-charts 라이선스는 TradingView를 제작자로 밝히고 https://www.tradingview.com/ 링크를 사용자에게
       * 보이는 화면에 두라고 요구하며, 이 옵션이 그 링크 요구를 충족시키는 공식 수단이다. 프로젝트 어디에도 대체
       * 표기가 없으므로 이 옵션을 끄면 비준수가 된다.
       * Leave `attributionLogo` at its default (true) — do not switch it off. The lightweight-charts licence requires a
       * TradingView credit and a link to https://www.tradingview.com/ on a user-visible page, and this option is the
       * official way to satisfy it; nothing else in the project credits TradingView.
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
        // 아래쪽은 거래량 띠에 넘겨준다 / The lower band belongs to the volume
        scaleMargins: { top: 0.08, bottom: PRICE_BOTTOM_MARGIN },
      },
      timeScale: { borderColor: styles.grid },
      /*
       * 축 날짜 로케일을 고정한다 — 기본값 `navigator.language`가 규격 밖 태그(헤드리스 크롬의 `en-US@posix`)면
       * 라이브러리의 `toLocaleString`이 RangeError로 죽어 시간축 라벨이 조용히 사라진다.
       * Pin the axis locale: a non-spec `navigator.language` (headless Chrome's `en-US@posix`) makes the library's
       * `toLocaleString` throw and silently erases the time-axis labels.
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
     * 거래량은 자기만의 오버레이 가격축(`priceScaleId: ''`)에 올리고 그 축을 아래 20%로 밀어 가격 스케일과 섞이지
     * 않게 한다. 막대 색은 캔들 방향을 따른다 (데이터 이펙트에서 점마다 지정).
     * The volume sits on its own overlay price scale (`priceScaleId: ''`), pushed into the bottom 20%; each bar's
     * colour follows its candle's direction (set per point in the data effect).
     */
    const volume = chart.addHistogramSeries({
      color: styles.volumeUp,
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 1 - VOLUME_SHARE, bottom: 0 } })

    // 크로스헤어 → 레전드. 차트 밖(time 없음)이면 마지막 캔들로 되돌린다 / Crosshair to legend; off-chart (no time) falls back to the last candle
    const onCrosshair = (param: MouseEventParams) => {
      if (param.time === undefined) {
        setHover(null)
        return
      }
      setHover(timeIndexRef.current.get(timeKey(param.time)) ?? null)
    }
    chart.subscribeCrosshairMove(onCrosshair)

    handleRef.current = { chart, candles, ma5, ma20, bollUpper, bollLower, volume, styles }
    fittedRef.current = null

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
  }, [showChart, theme, currency])

  /*
   * 데이터 반영 — 폴링·기간 변경은 `setData`로만 처리한다. 위 이펙트가 먼저 선언되어 있으므로 테마 변경 시에도
   * (재생성 → 이 이펙트) 순서가 보장된다.
   * Push the data in; a poll or a period change only ever calls `setData`. The effect above is declared first, so a
   * theme change is ordered as rebuild then refill.
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
  }, [data, showChart, theme, currency])

  /*
   * 지표 토글 — 시리즈를 지우고 다시 만들지 않고 `visible`만 바꾼다. 재생성 뒤에도 적용되도록 같은 의존성을 둔다.
   * The indicator toggles only flip `visible`, never recreate a series; the same dependencies re-apply after a rebuild.
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
    <Panel eyebrow="PRICE ACTION" title="가격 차트" action={<AsOfBadge asOf={asOf} />}>
      <div className="chart-toolbar">
        {/* `role="group"` + `aria-pressed` 토글 — 바뀌는 것은 canvas 하나라 tablist 모델이 맞지 않는다 / A labelled group of pressed toggles; what changes is one canvas, which the tablist model does not fit */}
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
        </>
      )}
    </Panel>
  )
}
