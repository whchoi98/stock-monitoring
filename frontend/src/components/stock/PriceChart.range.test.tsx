/**
 * PriceChart 시야(visible range) 회귀 테스트 — **진짜 lightweight-charts**를 jsdom에서 돌린다.
 * PriceChart visible-range regression tests, running the **real lightweight-charts** under jsdom.
 *
 * 스텁 기반 `PriceChart.panes.test.tsx`는 조립만 고정하고 시야 계산은 못 본다. 여기서는 canvas 2D 컨텍스트를 no-op Proxy로
 * 바꿔 라이브러리를 실제로 구동하고, 기간 전환(react-query 캐시 히트 — 로딩 상태 없이 데이터만 바뀌는 경로)에서 메인 차트가
 * 새 데이터에 `fitContent`되는지 확인한다.
 * The stub-based `PriceChart.panes.test.tsx` pins only the assembly and cannot see range maths. Here the canvas 2D
 * context is a no-op Proxy so the library really runs, and a period switch (a react-query cache hit — data changes
 * with no loading state) must leave the main chart fitted to the new data.
 *
 * 배경: 보조 패널의 `setData`는 그 패널의 시간축 논리 범위를 **동기적으로** 재계산·발화한다. 양방향 링크가 그 (옛 바 간격의)
 * 범위를 메인에 되돌려 보내면, 메인이 큐에 넣어 둔 `fitContent`(rAF까지 지연)가 교체되어 사라진다 — 1M(22봉)→1Y→1M에서
 * 22개 캔들이 오른쪽 64px에 몰린다. VOL 패널이 기본 ON이 되면서 기본 화면의 회귀가 됐다 (2026-09-07 리뷰 blocker).
 * Background: a sub-pane's `setData` recomputes and fires that pane's logical range **synchronously**. If the two-way
 * link echoes that (old-bar-spacing) range back to the main chart, the main chart's queued `fitContent` (deferred to
 * rAF) is replaced and lost — 1M (22 bars) → 1Y → 1M leaves 22 candles crammed into the right 64px. With the VOL pane
 * on by default this became a default-screen regression (review blocker, 2026-09-07).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { IChartApi, ISeriesApi, LogicalRange } from 'lightweight-charts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useChart } from '../../api/queries.ts'
import type { Candle, ChartData, ChartPeriod } from '../../api/types.ts'
import { PriceChart } from './PriceChart.tsx'

vi.mock('../../api/queries.ts', () => ({ useChart: vi.fn() }))

// 만들어진 차트를 순서대로 기록한다 (첫 번째가 메인) / Record the charts as they are created (the first is the main chart)
const created = vi.hoisted(() => ({ charts: [] as IChartApi[], candles: [] as ISeriesApi<'Candlestick'>[] }))

vi.mock('lightweight-charts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lightweight-charts')>()
  return {
    ...actual,
    createChart: (...args: Parameters<typeof actual.createChart>) => {
      const chart = actual.createChart(...args)
      created.charts.push(chart)
      const addCandlestickSeries = chart.addCandlestickSeries.bind(chart)
      chart.addCandlestickSeries = (...seriesArgs) => {
        const series = addCandlestickSeries(...seriesArgs)
        created.candles.push(series)
        return series
      }
      return chart
    },
  }
})

const WIDTH = 800

/** n개의 일봉 / n daily candles */
function candles(n: number, year: number, month: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: new Date(Date.UTC(year, month, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i,
    high: 105 + i,
    low: 99 + i,
    close: 104 + i,
    volume: 1_000 + i,
  }))
}

function chartData(period: ChartPeriod, rows: Candle[]): ChartData {
  return { symbol: 'AAPL', period, candles: rows, ma5: rows.map(() => null), ma20: rows.map(() => null), signals: [] }
}

/** 5Y 주봉 흉내 — 최저가의 20배 넘는 범위(NVDA 분할 조정 ≈ 11 → 236)에 골든 크로스 마커 하나 / A 5Y-like series spanning 20× its low (NVDA-like 11 → 236) with one golden-cross marker */
function wideRange(): ChartData {
  const rows = Array.from({ length: 60 }, (_, i) => {
    const price = 11 + (225 * i) / 59
    return {
      time: new Date(Date.UTC(2021, 8, 6 + i * 7)).toISOString().slice(0, 10),
      open: price,
      high: price * 1.03,
      low: price * 0.97,
      close: price * 1.01,
      volume: 1_000 + i,
    }
  })
  return {
    ...chartData('5y', rows),
    signals: [{ time: rows[5].time, kind: 'golden' }],
  }
}

const DATA: Partial<Record<ChartPeriod, ChartData>> = {
  '1m': chartData('1m', candles(22, 2026, 7)),
  '1y': chartData('1y', candles(120, 2026, 0)),
  '5y': wideRange(),
}

function hookResult(data: ChartData | undefined): QueryResult<ChartData> {
  return { data, asOf: undefined, marketOpen: undefined, isLoading: false, error: null }
}

/** rAF 몇 프레임을 흘려 지연된 시야 변경(InvalidateMask)을 적용시킨다 / Let a few animation frames apply the deferred range changes */
async function flushFrames(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
  }
}

/** 같은 폭의 독립 차트에서 n봉을 fitContent한 기준 시야 / The reference range: n bars fitted on a standalone chart of the same width */
async function fittedRange(rows: Candle[]): Promise<LogicalRange> {
  const actual = await vi.importActual<typeof import('lightweight-charts')>('lightweight-charts')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const chart = actual.createChart(host, { width: WIDTH, height: 300 })
  chart.addCandlestickSeries().setData(rows.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })))
  chart.timeScale().fitContent()
  await flushFrames()
  const range = chart.timeScale().getVisibleLogicalRange()
  chart.remove()
  host.remove()
  if (range === null) throw new Error('reference chart has no visible range')
  return range
}

function expectSameRange(actual: LogicalRange | null, expected: LogicalRange, label: string): void {
  expect(actual, `${label}: no visible range`).not.toBeNull()
  expect(Math.abs((actual as LogicalRange).from - expected.from), `${label}: from ${actual?.from} vs ${expected.from}`).toBeLessThan(1e-6)
  expect(Math.abs((actual as LogicalRange).to - expected.to), `${label}: to ${actual?.to} vs ${expected.to}`).toBeLessThan(1e-6)
}

function renderChart() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PriceChart symbol="AAPL" currency="USD" />
    </QueryClientProvider>,
  )
}

const noop = () => {}
/** canvas 2D 컨텍스트 대용 — 그리기는 전부 무시, 측정만 상수 / A stand-in 2D context: drawing is ignored, measurements are constants */
const contextProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'canvas') return null
      if (prop === 'measureText') return () => ({ width: 10 })
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
      if (prop === 'createLinearGradient') return () => ({ addColorStop: noop })
      return noop
    },
    set() {
      return true
    },
  },
)

let widthSpy: ReturnType<typeof vi.spyOn> | undefined
let heightSpy: ReturnType<typeof vi.spyOn> | undefined

beforeEach(() => {
  created.charts.length = 0
  created.candles.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    media: '',
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
  }))
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
  HTMLCanvasElement.prototype.getContext = (() => contextProxy) as unknown as typeof HTMLCanvasElement.prototype.getContext
  // jsdom은 레이아웃이 없어 컨테이너 크기가 0이다 — 차트가 읽는 크기를 고정한다 / jsdom has no layout, so the sizes the chart reads are pinned
  widthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH)
  heightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  // 진짜 라이브러리는 색을 파싱한다 — jsdom은 CSS 변수를 계산하지 않으므로 `readStyles()`가 읽는 토큰을 직접 심는다
  // The real library parses colours; jsdom computes no CSS variables, so the tokens `readStyles()` reads are planted
  const tokens: Record<string, string> = {
    '--up': '#e5484d', '--down': '#3b82f6', '--chart-ma5': '#ffffff', '--chart-ma20': '#f2a93b', '--chart-band': '#8b5cf6',
    '--chart-vol-up': '#7f2a2d', '--chart-vol-down': '#1e3a8a', '--text-dim': '#9aa4b2', '--text-strong': '#f5f7fa',
    '--border': '#2a2f3a', '--border-strong': '#3a4150', '--panel': '#0f1218', '--font-mono': 'monospace',
  }
  for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value)
  vi.mocked(useChart).mockImplementation((_symbol, period) => hookResult(DATA[period]))
})

afterEach(() => {
  widthSpy?.mockRestore()
  heightSpy?.mockRestore()
})

describe('PriceChart visible range', () => {
  it('기간을 바꿔 돌아와도(캐시 히트) 메인 차트는 새 데이터에 맞춰진다 / a period round-trip on cached data leaves the main chart fitted', async () => {
    renderChart()
    await flushFrames()
    const main = created.charts[0]
    expect(main).toBeDefined()

    // 1M(22봉) → 1Y(120봉) → 1M(22봉): 로딩 상태 없이 데이터만 바뀐다 / Data-only switches, no loading state in between
    fireEvent.click(screen.getByRole('button', { name: '1Y' }))
    await flushFrames()
    fireEvent.click(screen.getByRole('button', { name: '1M' }))
    await flushFrames()

    const expected = await fittedRange(DATA['1m']!.candles)
    expectSameRange(main.timeScale().getVisibleLogicalRange(), expected, 'main after 1M → 1Y → 1M')
  })

  it('범위가 넓은 5Y에서도 가격축은 0 아래로 내려가지 않는다 / on a wide-range 5Y the price axis never extends below zero', async () => {
    renderChart()
    await flushFrames()
    fireEvent.click(screen.getByRole('button', { name: '5Y' }))
    await flushFrames()

    const main = created.charts[0]
    const candlesSeries = created.candles[0]
    expect(candlesSeries).toBeDefined()
    const paneHeight = main.paneSize().height
    // 패널 맨 아래 픽셀의 가격 — 여백(마커 여백 포함)까지 라벨이 찍히므로 이 값이 음수면 음수 라벨이 나온다
    // The price at the pane's bottom pixel: labels are drawn into the margins (marker margins included), so a negative value here means a negative label
    const floor = candlesSeries.coordinateToPrice(paneHeight - 1)
    expect(floor, `axis floor ${floor} (pane ${paneHeight}px)`).not.toBeNull()
    expect(floor as number).toBeGreaterThanOrEqual(0)
    // 위쪽 여백은 그대로 — 최고가 위에 숨 쉴 공간이 있다 / Headroom above the high stays
    expect(candlesSeries.coordinateToPrice(0) as number).toBeGreaterThan(236)
  })

  it('거래량 패널의 시야는 메인과 같다 / the volume pane shows the same range as the main chart', async () => {
    renderChart()
    await flushFrames()
    fireEvent.click(screen.getByRole('button', { name: '1Y' }))
    await flushFrames()

    const [main, volume] = created.charts
    expect(volume, 'the volume pane chart').toBeDefined()
    const expected = await fittedRange(DATA['1y']!.candles)
    expectSameRange(main.timeScale().getVisibleLogicalRange(), expected, 'main after 1Y')
    expectSameRange(volume.timeScale().getVisibleLogicalRange(), expected, 'volume pane after 1Y')
  })
})
