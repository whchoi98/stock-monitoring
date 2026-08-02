/**
 * 가격 차트 — 캔들 + MA5/MA20 + 거래량 히스토그램 + 골든/데드 크로스 마커, 기간 탭(1W/1M/3M/1Y) 내장.
 * The price chart: candles, MA5/MA20, a volume histogram and golden/dead cross markers, with the
 * 1W/1M/3M/1Y period tabs built in.
 *
 * **색 예외 (계획이 승인한 유일한 예외)**: lightweight-charts 옵션은 canvas에 그리므로 CSS 변수를 받지
 * 못한다. 그래서 이 컴포넌트만 `getComputedStyle(document.documentElement).getPropertyValue('--up')`으로
 * 토큰 값을 읽어 넘긴다. 하드코딩된 색은 없고, 읽는 이름은 전부 tokens.css의 변수다.
 * 테마 토글은 `<html data-theme>`만 바꾸므로 canvas는 스스로 갱신되지 않는다 — 그 속성을
 * MutationObserver로 관찰해 테마가 바뀌면 차트를 다시 만든다(토큰을 다시 읽는 유일한 방법).
 * **Colour exception, the only one the plan sanctions**: lightweight-charts options paint onto a canvas
 * and cannot take CSS variables, so this component alone reads the token values through
 * `getComputedStyle(document.documentElement).getPropertyValue('--up')`. No colour is hardcoded; every
 * name read is a tokens.css variable. The theme toggle only flips `<html data-theme>`, which a canvas
 * cannot notice, so that attribute is watched with a MutationObserver and the chart is rebuilt on a
 * change — the only way to re-read the tokens.
 *
 * 데이터 변환은 `chartData.ts`의 순수 함수가 맡고(jsdom에서 차트는 못 돌지만 그 함수들은 테스트된다),
 * 이 파일은 차트 수명주기만 다룬다: 생성/파괴는 마운트·테마·표시여부에서만, 폴링 갱신은 `setData`로.
 * The data transforms live in `chartData.ts` as pure, tested functions (the chart itself cannot run under
 * jsdom); this file owns only the lifecycle: create and destroy on mount, theme and visibility, while a
 * poll updates through `setData`.
 */
import { useQueryClient } from '@tanstack/react-query'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import { createChart } from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'

import { useChart } from '../../api/queries.ts'
import type { Period } from '../../api/types.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { toCandleSeries, toLineSeries, toMarkers } from './chartData.ts'

/** 기간 탭 — 라벨은 대문자 관례, 값은 백엔드 `Period` / The period tabs; uppercase labels over the backend's `Period` */
const PERIODS: { value: Period; label: string }[] = [
  { value: '1w', label: '1W' },
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '1y', label: '1Y' },
]

/** 기본 기간 — 한 달이 일봉 차트의 기본 시야다 / The default window; a month is the natural default for daily candles */
const DEFAULT_PERIOD: Period = '1m'

/** 거래량 히스토그램이 차지하는 아래쪽 비율 (스펙: 하단 20%) / The share of the pane the volume takes (spec: the bottom 20%) */
const VOLUME_SHARE = 0.2

/** 캔들이 거래량 띠를 침범하지 않도록 두는 여유 / The gap that keeps the candles clear of the volume band */
const PRICE_BOTTOM_MARGIN = VOLUME_SHARE + 0.06

/** 차트에 넘길 스타일 값 — 전부 CSS 토큰에서 읽는다 / The style values handed to the chart, all read from CSS tokens */
interface ChartStyles {
  /** 상승 (`--up`) / Up (`--up`) */
  up: string
  /** 하락 (`--down`) / Down (`--down`) */
  down: string
  /** MA5 라인 (`--text-strong`) / The MA5 line (`--text-strong`) */
  ma5: string
  /** MA20 라인 (`--accent`) / The MA20 line (`--accent`) */
  ma20: string
  /** 거래량 막대 (`--text`) / The volume bars (`--text`) */
  volume: string
  /** 축 글자 (`--text`) / Axis text (`--text`) */
  text: string
  /** 격자·경계선 (`--bg`) — 카드 위에서 대비를 만든다 / Grid and borders (`--bg`), which contrast against the card */
  grid: string
  /** 차트 배경 (`--card`) — 카드 안에 앉으므로 / The chart background (`--card`), since it sits inside a card */
  background: string
  /** 축 글꼴 — canvas는 CSS를 상속하지 않으므로 본문 글꼴을 읽어 넘긴다 / Axis font: a canvas inherits no CSS, so the body font is passed in */
  fontFamily: string
}

/**
 * 현재 테마의 토큰 값을 읽는다 / Read the current theme's token values.
 *
 * 계획이 승인한 색 예외의 전부다 (파일 머리 주석 참조).
 * This is the whole of the plan-sanctioned colour exception (see the file's opening comment).
 */
function readStyles(): ChartStyles {
  const root = getComputedStyle(document.documentElement)
  const token = (name: string) => root.getPropertyValue(name).trim()
  return {
    up: token('--up'),
    down: token('--down'),
    ma5: token('--text-strong'),
    ma20: token('--accent'),
    volume: token('--text'),
    text: token('--text'),
    grid: token('--bg'),
    background: token('--card'),
    fontFamily: getComputedStyle(document.body).fontFamily,
  }
}

/**
 * `<html data-theme>`를 관찰한다 / Watch `<html data-theme>`.
 *
 * 반환값이 바뀌면 차트를 다시 만든다 — canvas에 이미 칠한 색은 CSS 변수로 되돌릴 수 없다.
 * A change in the returned value rebuilds the chart: colours already painted onto a canvas cannot be
 * revisited by a CSS variable.
 */
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
  volume: ISeriesApi<'Histogram'>
  styles: ChartStyles
}

export interface PriceChartProps {
  /** 종목 심볼 — 그대로 F2 훅에 넘긴다 / The symbol, handed straight to the F2 hook */
  symbol: string
}

export function PriceChart({ symbol }: PriceChartProps) {
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD)
  const { data, asOf, isLoading, error } = useChart(symbol, period)
  const theme = useThemeAttribute()
  const queryClient = useQueryClient()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<ChartHandle | null>(null)
  /*
   * 마지막으로 시야를 맞춘 데이터의 표식 / A tag for the data the viewport was last fitted to.
   *
   * 45초 폴링마다 `fitContent()`를 부르면 사용자의 확대/이동이 되돌아간다. 그래서 심볼·기간이 바뀌거나
   * 캔들 개수가 달라졌을 때(= 시간 범위가 실제로 달라졌을 때)만 다시 맞춘다.
   * Calling `fitContent()` on every 45s poll would undo the user's zoom and pan, so the viewport is
   * refitted only when the symbol or period changes, or the candle count does — that is, when the time
   * range really changed.
   */
  const fittedRef = useRef<string | null>(null)

  /*
   * F2 훅은 `refetch`를 노출하지 않으므로(계약: `{data, asOf, marketOpen, isLoading, error}`)
   * 재시도는 이 위젯의 쿼리 키만 무효화한다 — 키는 `api/queries.ts`의 `['chart', symbol, period]`와 같아야 한다.
   * The F2 hooks expose no `refetch` (their contract is `{data, asOf, marketOpen, isLoading, error}`), so
   * a retry invalidates just this widget's key, which must mirror `['chart', symbol, period]` in
   * `api/queries.ts`.
   */
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['chart', symbol, period] })
  }

  const hasCandles = data !== undefined && data.candles.length > 0
  /** 차트 컨테이너를 렌더하는 조건 — 아래 생성 이펙트의 전제다 / When the container is rendered, which the create effect below depends on */
  const showChart = error === null && !isLoading && hasCandles

  /*
   * 차트 생성/파괴 — 컨테이너가 생겼을 때와 테마가 바뀔 때만. 데이터 폴링으로는 다시 만들지 않는다.
   * Create and destroy the chart, only when the container appears and when the theme changes; a data
   * poll never rebuilds it.
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
       * lightweight-charts 라이선스는 TradingView를 제작자로 밝히고 https://www.tradingview.com/ 링크를
       * 사용자에게 보이는 화면에 두라고 요구하며(`node_modules/lightweight-charts/README.md`),
       * 이 옵션이 그 링크 요구를 충족시키는 공식 수단이다. 패키지에 NOTICE 파일이 없고 프로젝트
       * 어디에도 TradingView 표기가 없으므로, 이 옵션을 끄면 대체 표기가 사라진다.
       * Leave `attributionLogo` at its default (true) — do not switch it off. The lightweight-charts
       * licence requires naming TradingView as the creator and putting a link to
       * https://www.tradingview.com/ on a page visible to users (see the package README), and this option
       * is the official way to satisfy that link requirement. The package ships no NOTICE file and the
       * project carries no TradingView attribution anywhere else, so disabling it would leave none.
       */
      layout: {
        background: { color: styles.background },
        textColor: styles.text,
        fontFamily: styles.fontFamily,
      },
      grid: {
        vertLines: { color: styles.grid },
        horzLines: { color: styles.grid },
      },
      rightPriceScale: {
        borderColor: styles.grid,
        // 아래쪽은 거래량 띠에 넘겨준다 / The lower band belongs to the volume
        scaleMargins: { top: 0.08, bottom: PRICE_BOTTOM_MARGIN },
      },
      timeScale: { borderColor: styles.grid },
      /*
       * 축 날짜 로케일을 고정한다. 기본값은 `navigator.language`인데, 브라우저가 규격 밖 태그를
       * 보고하면(예: 헤드리스 크롬의 `en-US@posix`) 라이브러리의 `toLocaleString`이 RangeError로
       * 죽어 시간축 라벨이 조용히 사라진다. 프로젝트 관례대로(뉴스 발행시각 `ko-KR`) 명시한다.
       * Pin the axis date locale. The default is `navigator.language`, and a browser reporting a tag
       * outside the spec (headless Chrome's `en-US@posix`, say) makes the library's `toLocaleString`
       * throw a RangeError that silently erases the time-axis labels. Stated explicitly, as the project
       * already does for the news timestamps (`ko-KR`).
       */
      localization: { locale: 'ko-KR' },
    })

    const candles = chart.addCandlestickSeries({
      upColor: styles.up,
      downColor: styles.down,
      borderUpColor: styles.up,
      borderDownColor: styles.down,
      wickUpColor: styles.up,
      wickDownColor: styles.down,
    })

    /** MA 라인은 보조선이다 — 가격축 라벨/기준선을 만들지 않는다 / The MAs are guides: no axis label, no price line */
    const line = (color: string) => ({
      color,
      lineWidth: 1 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    const ma5 = chart.addLineSeries(line(styles.ma5))
    const ma20 = chart.addLineSeries(line(styles.ma20))

    /*
     * 거래량은 자기만의 오버레이 가격축(`priceScaleId: ''`)에 올리고 그 축을 아래 20%로 밀어
     * 가격 스케일과 섞이지 않게 한다.
     * The volume sits on its own overlay price scale (`priceScaleId: ''`), pushed into the bottom 20% so
     * it never mixes with the price scale.
     */
    const volume = chart.addHistogramSeries({
      color: styles.volume,
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 1 - VOLUME_SHARE, bottom: 0 } })

    handleRef.current = { chart, candles, ma5, ma20, volume, styles }
    fittedRef.current = null

    // 카드 폭이 바뀌면 캔버스도 따라가야 한다 (높이는 CSS가 정한다) / The canvas follows the card's width; CSS owns the height
    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      chart.remove()
      handleRef.current = null
    }
  }, [showChart, theme])

  /*
   * 데이터 반영 — 폴링·기간 변경은 `setData`로만 처리한다. 위 이펙트가 먼저 선언되어 있으므로
   * 테마 변경 시에도 (재생성 → 이 이펙트) 순서가 보장된다.
   * Push the data in; a poll or a period change only ever calls `setData`. The effect above is declared
   * first, so a theme change is ordered as rebuild then refill.
   */
  useEffect(() => {
    const handle = handleRef.current
    if (handle === null || data === undefined) return

    const times = data.candles.map((candle) => candle.time)
    handle.candles.setData(toCandleSeries(data.candles))
    handle.ma5.setData(toLineSeries(times, data.ma5))
    handle.ma20.setData(toLineSeries(times, data.ma20))
    handle.volume.setData(toLineSeries(times, data.candles.map((candle) => candle.volume)))
    handle.candles.setMarkers(
      toMarkers(data.signals, { golden: handle.styles.up, dead: handle.styles.down }),
    )

    /*
     * 1w는 시간봉이라 시각까지 보여야 날짜가 반복되지 않는다 (백엔드가 `...THH:MM`을 준다).
     * The 1w window is hourly, so the clock must show or the dates repeat (the backend sends `...THH:MM`).
     */
    handle.chart
      .timeScale()
      .applyOptions({ timeVisible: times.some((time) => time.includes('T')), secondsVisible: false })

    const fitKey = `${data.symbol}:${data.period}:${data.candles.length}`
    if (fittedRef.current !== fitKey) {
      handle.chart.timeScale().fitContent()
      fittedRef.current = fitKey
    }
  }, [data, showChart, theme])

  return (
    <Card
      title="가격 차트"
      action={
        <>
          {/*
            F4의 시장 탭과 같은 형식이다 — `role="tablist"/"tab"`은 tabpanel 배선을 함의하는데
            바뀌는 것은 canvas 하나이므로 `role="group"` + `aria-pressed` 토글 버튼을 쓴다.
            The same shape as F4's market tabs: `role="tablist"/"tab"` implies a tabpanel relationship,
            and what changes here is a single canvas, so this is a labelled group of pressed toggles.
          */}
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
          <AsOfBadge asOf={asOf} />
        </>
      }
    >
      {error !== null ? (
        <ErrorCard onRetry={retry} message="가격 차트를 불러오지 못했습니다" />
      ) : isLoading ? (
        <Spinner />
      ) : !hasCandles ? (
        <p className="empty">차트 데이터가 없습니다</p>
      ) : (
        /* 크기는 CSS가 정한다 — lightweight-charts가 컨테이너 크기를 읽어 캔버스를 만든다 /
           CSS owns the size; lightweight-charts reads the container's box to build its canvas */
        <div className="price-chart" ref={containerRef} />
      )}
    </Card>
  )
}
