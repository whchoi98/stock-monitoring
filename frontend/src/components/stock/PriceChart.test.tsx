/**
 * PriceChart 껍데기 테스트 — 차트가 뜨지 않는 분기만 검증한다.
 * PriceChart shell tests, covering only the branches where no chart is created.
 *
 * lightweight-charts는 canvas를 요구하므로 jsdom에서 렌더될 수 없다. 그래서 캔들이 있는 상태는
 * 여기서 마운트하지 않는다(그 로직은 `chartData.test.ts` + 실제 브라우저 육안 확인이 담당한다).
 * 대신 캔버스가 필요 없는 계약을 고정한다: 기간 탭이 훅에 넘기는 값, 로딩/실패/빈 데이터 분기,
 * 그리고 재시도가 무효화하는 쿼리 키(`api/queries.ts`와 문자열로 중복되므로 테스트가 못을 박아둔다).
 * lightweight-charts needs a canvas and cannot render under jsdom, so a state with candles is never
 * mounted here (`chartData.test.ts` plus the real-browser visual check cover that). What is pinned
 * instead are the contracts that need no canvas: the value the period tabs hand the hook, the loading,
 * failure and empty branches, and the query key the retry invalidates — a string duplicated from
 * `api/queries.ts`, so a test nails it down.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useChart } from '../../api/queries.ts'
import type { ChartData } from '../../api/types.ts'
import { PriceChart } from './PriceChart.tsx'
// Vite의 `?raw`로 구현 파일 원문을 읽는다 (아래 라이선스 가드용) / The implementation's own text via Vite's `?raw`, for the licence guard below
import priceChartSource from './PriceChart.tsx?raw'

vi.mock('../../api/queries.ts', () => ({ useChart: vi.fn() }))

/** 캔들이 없는 차트 응답 — 이 상태에서는 차트를 만들지 않으므로 jsdom에서 안전하다 / A candle-less response, safe under jsdom because no chart is built */
const EMPTY_CHART: ChartData = {
  symbol: 'AAPL',
  period: '1m',
  candles: [],
  ma5: [],
  ma20: [],
  signals: [],
}

function hookResult(over: Partial<QueryResult<ChartData>>): QueryResult<ChartData> {
  return {
    data: undefined,
    asOf: undefined,
    marketOpen: undefined,
    isLoading: false,
    error: null,
    ...over,
  }
}

function renderChart(symbol = 'AAPL') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <PriceChart symbol={symbol} />
    </QueryClientProvider>,
  )
  return { ...view, queryClient }
}

beforeEach(() => {
  vi.mocked(useChart).mockReturnValue(hookResult({ data: EMPTY_CHART }))
})

describe('PriceChart', () => {
  it('기간 탭 4개를 1M 선택 상태로 렌더한다 / renders the four period tabs with 1M selected', () => {
    renderChart()

    const tabs = screen.getByRole('group', { name: '기간 선택' })
    expect(Array.from(tabs.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      '1W',
      '1M',
      '3M',
      '1Y',
    ])
    expect(screen.getByRole('button', { name: '1M' }).getAttribute('aria-pressed')).toBe('true')
    expect(vi.mocked(useChart)).toHaveBeenCalledWith('AAPL', '1m')
  })

  it('탭을 누르면 그 기간으로 다시 조회한다 / a tab click refetches that period', () => {
    renderChart()

    fireEvent.click(screen.getByRole('button', { name: '1Y' }))

    expect(vi.mocked(useChart)).toHaveBeenLastCalledWith('AAPL', '1y')
    expect(screen.getByRole('button', { name: '1Y' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '1M' }).getAttribute('aria-pressed')).toBe('false')
  })

  /*
   * 지표 토글 — MA5·MA20·VOL은 켜진 채, BOLL은 꺼진 채 시작한다. 토글은 시리즈의 `visible`만 바꾸므로(캔버스가 없어도
   * 상태는 돈다) 여기서는 눌림 상태의 계약만 못박는다.
   * The indicator toggles start with MA5, MA20 and VOL on and BOLL off. A toggle only flips a series' `visible`, so
   * (with no canvas) only the pressed-state contract is pinned here.
   */
  it('지표 토글 4개를 BOLL만 꺼진 상태로 렌더하고 누르면 뒤집는다 / renders the four indicator toggles with only BOLL off, and flips on click', () => {
    renderChart()

    const toggles = screen.getByRole('group', { name: '지표 선택' })
    expect(Array.from(toggles.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'MA5',
      'MA20',
      'BOLL',
      'VOL',
    ])
    expect(screen.getByRole('button', { name: 'MA5' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'BOLL' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'BOLL' }))
    expect(screen.getByRole('button', { name: 'BOLL' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'VOL' }))
    expect(screen.getByRole('button', { name: 'VOL' }).getAttribute('aria-pressed')).toBe('false')
    // 기간은 그대로다 — 두 그룹은 독립이다 / The period is untouched; the two groups are independent
    expect(screen.getByRole('button', { name: '1M' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('로딩 중에는 스피너만 보인다 / shows only a spinner while loading', () => {
    vi.mocked(useChart).mockReturnValue(hookResult({ isLoading: true }))
    const { container } = renderChart()

    expect(screen.getByRole('status')).toBeTruthy()
    expect(container.querySelector('.price-chart')).toBeNull()
  })

  it('캔들이 없으면 빈 상태 문구를 낸다 / states the empty case when there are no candles', () => {
    const { container } = renderChart()

    expect(screen.getByText('차트 데이터가 없습니다')).toBeTruthy()
    expect(container.querySelector('.price-chart')).toBeNull()
  })

  it('실패하면 에러 카드가 뜨고 재시도가 해당 기간의 차트 쿼리를 무효화한다 / fails into an error card whose retry invalidates that period’s chart query', () => {
    vi.mocked(useChart).mockReturnValue(hookResult({ error: new Error('boom') }))
    const { queryClient, container } = renderChart('005930.KS')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(container.querySelector('.price-chart')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chart', '005930.KS', '1m'] })

    // 실패해도 기간 탭은 남는다 — 다른 기간으로 빠져나갈 수 있어야 한다
    // The tabs survive a failure, so another window is still reachable
    fireEvent.click(screen.getByRole('button', { name: '3M' }))
    expect(vi.mocked(useChart)).toHaveBeenLastCalledWith('005930.KS', '3m')
  })

  /*
   * 라이선스 회귀 가드 — 동작 테스트가 아니라 컴플라이언스 가드다.
   * lightweight-charts 라이선스는 TradingView 표기 + https://www.tradingview.com/ 링크를 사용자에게
   * 보이는 화면에 요구하고, `attributionLogo`(기본 true)가 그 요구를 충족시키는 공식 수단이다.
   * 패키지에 NOTICE 파일이 없고 프로젝트에 대체 표기도 없어서, 이 옵션을 끄면 조용히 비준수가 된다.
   * 차트 생성 경로는 canvas가 없는 jsdom에서 실행할 수 없으므로(그래서 링크 자체는 실제 브라우저에서
   * 확인했다) 소스에 그 한 줄이 되살아나는 것만 여기서 막는다.
   * A licence regression guard rather than a behaviour test. The lightweight-charts licence requires a
   * TradingView credit and a link to https://www.tradingview.com/ on a user-visible page, and
   * `attributionLogo` (true by default) is the official way to satisfy it. The package ships no NOTICE
   * file and the project credits TradingView nowhere else, so switching it off is silent
   * non-compliance. The chart-creation path cannot run under jsdom (which is why the link itself was
   * verified in a real browser), so what is guarded here is that one line coming back.
   */
  it('TradingView 어트리뷰션 로고를 끄지 않는다 (라이선스) / never disables the TradingView attribution logo, per the licence', () => {
    // 원문 전체를 단언에 넘기면 실패 메시지가 파일 하나를 그대로 토해낸다 — 불리언으로 좁힌다
    // Asserting on the whole text would vomit the entire file into the failure message; narrow it to a boolean
    const disabled = priceChartSource.replace(/\s/g, '').includes('attributionLogo:false')

    expect(
      disabled,
      'attributionLogo를 끄면 TradingView 링크가 사라져 lightweight-charts 라이선스를 위반한다 (대체 표기 없음) / ' +
        'disabling attributionLogo drops the TradingView link and breaks the lightweight-charts licence (nothing else credits it)',
    ).toBe(false)
  })
})
