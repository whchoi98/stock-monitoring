/**
 * PriceChart 패널 조립 테스트 — lightweight-charts를 기록용 스텁으로 바꿔 캔들 뷰의 차트 구성을 검증한다.
 * PriceChart pane-assembly tests, with lightweight-charts replaced by a recording stub to verify the candle view's layout.
 *
 * jsdom에는 canvas가 없어 진짜 라이브러리는 돌 수 없다(`PriceChart.test.tsx`가 캔들 뷰를 마운트하지 않는 이유).
 * 그래서 여기서는 `createChart`를 스텁으로 바꾸고 "어느 차트에 어떤 시리즈가 올라가며 가격축 마진이 얼마인가"만
 * 고정한다. 그림 자체는 실제 브라우저 스크린샷이 검증한다.
 * jsdom has no canvas, so the real library cannot run (which is why `PriceChart.test.tsx` never mounts the candle
 * view). Here `createChart` is stubbed and only the assembly is pinned: which series lands on which chart and what
 * the price-scale margins are. The rendering itself is verified by real-browser screenshots.
 *
 * 배경: 거래량이 메인 차트의 오버레이 축(하단 26% 마진)에 있을 때, 5Y처럼 가격 범위가 넓은 기간에서 메인 가격축
 * 라벨이 그 마진 영역까지 이어져 0 / -50000 / -100000이 찍혔다. 거래량을 RSI/MACD처럼 별도 동기 패널로 빼면
 * 메인 축은 가격 범위만 담당한다.
 * Background: with the volume on the main chart's overlay scale (a 26% bottom margin), a wide-range period such as 5Y
 * extended the main price labels into that margin, printing 0 / -50000 / -100000. Moving the volume into its own
 * synced pane, like RSI/MACD, leaves the main axis to the price range alone.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useChart } from '../../api/queries.ts'
import type { ChartData } from '../../api/types.ts'
import { PriceChart } from './PriceChart.tsx'

vi.mock('../../api/queries.ts', () => ({ useChart: vi.fn() }))

interface FakeSeries {
  kind: 'Candlestick' | 'Line' | 'Histogram'
  options: Record<string, unknown>
  setData: Mock
  applyOptions: Mock
}

interface FakeChart {
  options: { rightPriceScale?: { scaleMargins?: { top: number; bottom: number } } }
  series: FakeSeries[]
  removed: boolean
  crosshairHandlers: Set<(param: unknown) => void>
  setCrosshairPosition: Mock
  clearCrosshairPosition: Mock
  timeScale: { subscribeVisibleLogicalRangeChange: Mock }
}

// `vi.mock`은 import 위로 끌어올려지므로 팩토리가 참조하는 상태도 함께 끌어올린다 / `vi.mock` is hoisted, so the state its factory touches is hoisted too
const state = vi.hoisted(() => ({ charts: [] as FakeChart[] }))

vi.mock('lightweight-charts', () => {
  const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 }
  const createChart = (_container: HTMLElement, options: FakeChart['options']) => {
    const timeScale = {
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      setVisibleLogicalRange: vi.fn(),
      getVisibleLogicalRange: () => null,
      fitContent: vi.fn(),
      applyOptions: vi.fn(),
    }
    const record: FakeChart = {
      options,
      series: [],
      removed: false,
      crosshairHandlers: new Set(),
      setCrosshairPosition: vi.fn(),
      clearCrosshairPosition: vi.fn(),
      timeScale,
    }
    const addSeries =
      (kind: FakeSeries['kind']) =>
      (seriesOptions: Record<string, unknown> = {}) => {
        const series = {
          kind,
          options: seriesOptions,
          setData: vi.fn(),
          applyOptions: vi.fn(),
          setMarkers: vi.fn(),
          createPriceLine: vi.fn(() => ({})),
          removePriceLine: vi.fn(),
          priceScale: () => ({ applyOptions: vi.fn() }),
        }
        record.series.push(series)
        return series
      }
    state.charts.push(record)
    return {
      addCandlestickSeries: addSeries('Candlestick'),
      addLineSeries: addSeries('Line'),
      addHistogramSeries: addSeries('Histogram'),
      subscribeCrosshairMove: (handler: (param: unknown) => void) => record.crosshairHandlers.add(handler),
      unsubscribeCrosshairMove: (handler: (param: unknown) => void) => record.crosshairHandlers.delete(handler),
      setCrosshairPosition: record.setCrosshairPosition,
      clearCrosshairPosition: record.clearCrosshairPosition,
      timeScale: () => timeScale,
      applyOptions: vi.fn(),
      remove: () => {
        record.removed = true
      },
    }
  }
  return { createChart, LineStyle }
})

const WITH_CANDLES: ChartData = {
  symbol: 'AAPL',
  period: '1m',
  candles: [
    { time: '2026-09-01', open: 100, high: 105, low: 99, close: 104, volume: 1_000 },
    { time: '2026-09-02', open: 104, high: 106, low: 101, close: 102, volume: 900 },
  ],
  ma5: [null, null],
  ma20: [null, null],
  signals: [],
}

function hookResult(over: Partial<QueryResult<ChartData>>): QueryResult<ChartData> {
  return { data: undefined, asOf: undefined, marketOpen: undefined, isLoading: false, error: null, ...over }
}

function renderCandleView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PriceChart symbol="AAPL" currency="USD" />
    </QueryClientProvider>,
  )
}

const mainChart = () => state.charts.find((chart) => chart.series.some((series) => series.kind === 'Candlestick'))
const isVolumeHistogram = (series: FakeSeries) =>
  series.kind === 'Histogram' && (series.options.priceFormat as { type?: string } | undefined)?.type === 'volume'
const volumePane = () => state.charts.find((chart) => chart !== mainChart() && chart.series.some(isVolumeHistogram))
const paneLabels = () => Array.from(document.querySelectorAll('.pane-label')).map((el) => el.textContent)

beforeEach(() => {
  state.charts.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  // jsdom은 CSS 변수를 계산하지 않으므로 차트가 읽는 거래량 색 토큰을 직접 심는다 / jsdom computes no CSS variables, so the volume colour tokens the chart reads are planted directly
  document.documentElement.style.setProperty('--chart-vol-up', 'rgb(200, 0, 0)')
  document.documentElement.style.setProperty('--chart-vol-down', 'rgb(0, 0, 200)')
  vi.mocked(useChart).mockReturnValue(hookResult({ data: WITH_CANDLES }))
})

describe('PriceChart panes', () => {
  it('메인 가격축은 거래량 띠를 위한 하단 마진을 두지 않는다 / the main price scale reserves no bottom band for a volume overlay', () => {
    renderCandleView()

    const main = mainChart()
    expect(main).toBeDefined()
    // 하단 마진이 넓으면 5Y처럼 범위가 큰 기간에서 라벨이 0 아래로 이어진다 / A wide bottom margin runs the labels below 0 on a wide-range period
    expect(main?.options.rightPriceScale?.scaleMargins?.bottom ?? 1).toBeLessThanOrEqual(0.1)
    expect(main?.series.some((series) => series.kind === 'Histogram')).toBe(false)
  })

  it('VOL은 거래량을 가격 차트 아래 별도 패널로 그린다 / VOL draws the volume as its own pane below the price chart', () => {
    renderCandleView()

    expect(paneLabels()).toContain('VOL')
    const pane = volumePane()
    expect(pane).toBeDefined()
    const histogram = pane?.series.find(isVolumeHistogram)
    const bars = histogram?.setData.mock.calls.at(-1)?.[0] as Array<{ value: number; color: string }>
    expect(bars.map((bar) => bar.value)).toEqual([1_000, 900])
    // 막대 색은 캔들 방향을 따른다 (상승 → --chart-vol-up, 하락 → --chart-vol-down) / Bar colours follow the candle direction
    expect(bars.map((bar) => bar.color)).toEqual(['rgb(200, 0, 0)', 'rgb(0, 0, 200)'])
  })

  it('거래량 패널은 메인 차트와 시간축·크로스헤어를 공유한다 / the volume pane shares the main chart’s time scale and crosshair', () => {
    renderCandleView()

    const main = mainChart()
    const pane = volumePane()
    expect(main?.timeScale.subscribeVisibleLogicalRangeChange).toHaveBeenCalled()
    expect(pane?.timeScale.subscribeVisibleLogicalRangeChange).toHaveBeenCalled()

    const [onMainCrosshair] = Array.from(main?.crosshairHandlers ?? [])
    act(() => onMainCrosshair({ time: '2026-09-02', point: { x: 0, y: 0 }, seriesData: new Map() }))
    // 가로선 자리에 그 시각의 거래량을 놓는다 / The horizontal anchor is that bar's volume
    expect(pane?.setCrosshairPosition).toHaveBeenCalledWith(900, '2026-09-02', pane?.series.find(isVolumeHistogram))
  })

  it('VOL을 끄면 거래량 패널이 사라진다 / switching VOL off removes the volume pane', () => {
    renderCandleView()
    const pane = volumePane()

    fireEvent.click(screen.getByRole('button', { name: 'VOL' }))

    expect(pane?.removed).toBe(true)
    expect(paneLabels()).not.toContain('VOL')
  })
})
