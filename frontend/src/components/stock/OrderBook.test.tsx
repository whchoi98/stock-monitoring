/**
 * OrderBook 테스트 — 호가창의 행 분리·색·잔량 막대·시뮬레이션 뱃지·분기를 고정한다.
 * OrderBook tests; they pin the ask/bid split, the colours, the quantity bars, the simulated badge
 * and the branches.
 *
 * F2 훅(`useOrderBook`)은 `vi.mock`으로 고정한다 — 이 테스트는 네트워크가 아니라 호가창을 검증한다.
 * `QueryClientProvider`는 재시도 버튼이 쓰는 `useQueryClient()` 때문에 필요하다 (라우팅은 쓰지 않는다).
 * The F2 hook (`useOrderBook`) is pinned with `vi.mock`: this file tests the panel, not the network.
 * `QueryClientProvider` is required by the retry button's `useQueryClient()`; no routing is involved.
 *
 * **길이를 가정하지 않는다**: 백엔드는 보통 매도 10 + 매수 10을 주지만 엣지 케이스에서는 더 적다
 * (`api/types.ts`의 `OrderBookData` 주석). 그래서 20건 픽스처와 5건 픽스처를 함께 검증한다.
 * **No length is assumed**: the backend normally sends 10 asks plus 10 bids but yields fewer in edge
 * cases (see the `OrderBookData` comment in `api/types.ts`), so a 20-entry fixture and a 5-entry one are
 * both exercised.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useOrderBook } from '../../api/queries.ts'
import type { OrderBookData, OrderBookEntry } from '../../api/types.ts'
import { OrderBook } from './OrderBook.tsx'

vi.mock('../../api/queries.ts', () => ({ useOrderBook: vi.fn() }))

const SYMBOL = '005930.KS'

/**
 * 매도 10단계 — 가격은 오름차순, 잔량은 뒤섞여 있다 (컴포넌트가 정렬한다는 것을 보이기 위해).
 * Ten ask levels; prices ascend and quantities are unsorted, so the component's own ordering shows.
 */
const ASK_PRICES = [263000, 263500, 264000, 264500, 265000, 265500, 266000, 266500, 267000, 267500]
/** 인덱스 6(가격 266000)의 200은 최대 잔량 400의 정확히 절반이다 / Index 6 (price 266000) holds exactly half of the 400 peak */
const ASK_QTYS = [120, 250, 90, 310, 175, 60, 200, 140, 95, 230]

/** 매수 10단계 — 가격은 내림차순, 인덱스 0(가격 262000)의 400이 전체 최대 잔량이다 / Ten bid levels, descending; index 0's 400 is the overall peak */
const BID_PRICES = [262000, 261500, 261000, 260500, 260000, 259500, 259000, 258500, 258000, 257500]
const BID_QTYS = [400, 210, 130, 85, 265, 150, 70, 190, 110, 245]

function entries(
  prices: number[],
  qtys: number[],
  side: OrderBookEntry['side'],
): OrderBookEntry[] {
  return prices.map((price, index) => ({ price, qty: qtys[index]!, side }))
}

/** 매도 10 + 매수 20 = 고정 20건 픽스처 (브리프 지정) / The fixed 20-entry fixture the brief specifies */
const TWENTY: OrderBookData = {
  symbol: SYMBOL,
  market: 'kr',
  price: 262500,
  entries: [...entries(ASK_PRICES, ASK_QTYS, 'ask'), ...entries(BID_PRICES, BID_QTYS, 'bid')],
  simulated: true,
}

/** 훅 반환값 조립 — 지정하지 않은 필드는 "아직 없음" / Build a hook result; unspecified fields mean "not there yet" */
function hookResult(over: Partial<QueryResult<OrderBookData>>): QueryResult<OrderBookData> {
  return {
    data: undefined,
    asOf: undefined,
    marketOpen: undefined,
    isLoading: false,
    error: null,
    ...over,
  }
}

function renderOrderBook(symbol = SYMBOL) {
  // 폴링/재시도 없는 클라이언트 — 테스트가 타이머에 매달리지 않게 한다 / No polling or retries here
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OrderBook symbol={symbol} />
    </QueryClientProvider>,
  )
  const rows = (side?: 'ask' | 'bid') =>
    Array.from(
      view.container.querySelectorAll(
        side === undefined ? '.orderbook-row' : `.orderbook-row-${side}`,
      ),
    )
  return { ...view, queryClient, rows }
}

/** 한 행의 잔량 막대 폭을 퍼센트 숫자로 / One row's quantity-bar width as a plain percentage number */
function barWidth(row: Element): number {
  const fill = row.querySelector<HTMLElement>('.orderbook-fill')
  if (fill === null) throw new Error('행에 잔량 막대가 없다 / the row has no quantity bar')
  expect(fill.style.width.endsWith('%')).toBe(true)
  return Number.parseFloat(fill.style.width)
}

function priceOf(row: Element): string {
  return row.querySelector('.orderbook-price')?.textContent ?? ''
}

beforeEach(() => {
  vi.mocked(useOrderBook).mockReturnValue(hookResult({ data: TWENTY }))
})

describe('OrderBook', () => {
  it('20건이면 매도 10행 + 매수 10행을 렌더한다 / renders ten ask rows and ten bid rows from twenty entries', () => {
    const { rows } = renderOrderBook()

    expect(rows('ask')).toHaveLength(10)
    expect(rows('bid')).toHaveLength(10)
    expect(rows()).toHaveLength(20)
    expect(vi.mocked(useOrderBook)).toHaveBeenCalledWith(SYMBOL)
  })

  it('매도 행은 하락색(down), 매수 행은 상승색(up) 클래스를 갖는다 / marks ask rows down and bid rows up', () => {
    const { rows } = renderOrderBook()

    for (const row of rows('ask')) expect(row.classList.contains('down')).toBe(true)
    for (const row of rows('bid')) expect(row.classList.contains('up')).toBe(true)
    // 반대 색이 섞이지 않는다 / No row carries the other side's colour
    for (const row of rows('ask')) expect(row.classList.contains('up')).toBe(false)
    for (const row of rows('bid')) expect(row.classList.contains('down')).toBe(false)
  })

  it('최대 잔량 행의 막대가 100%이고 나머지는 그 비율이다 / the peak-quantity row fills 100% and the rest scale to it', () => {
    const { rows } = renderOrderBook()

    // 전체 최대 잔량은 매수 400 (매도·매수를 하나의 기준으로 비교해야 깊이가 읽힌다)
    // The peak is the 400 on the bid side; one shared scale is what makes the depth comparable
    const peak = rows('bid').find((row) => priceOf(row) === '262,000')!
    expect(barWidth(peak)).toBe(100)

    // 정확히 절반인 매도 200 → 50% / The 200 on the ask side is exactly half, so 50%
    const half = rows('ask').find((row) => priceOf(row) === '266,000')!
    expect(barWidth(half)).toBe(50)

    // 100%는 단 한 행뿐이다 / Exactly one row is full
    expect(rows().filter((row) => barWidth(row) === 100)).toHaveLength(1)
  })

  it('시뮬레이션 뱃지를 표시한다 (실데이터가 아니다) / shows the simulated badge, because this is not real data', () => {
    renderOrderBook()

    expect(screen.getByText('시뮬레이션')).toBeTruthy()
  })

  it('매도는 위에서 아래로 내림차순, 매수도 내림차순으로 쌓인다 / stacks asks and bids high price first', () => {
    const { rows } = renderOrderBook()

    expect(rows('ask').map(priceOf)).toEqual([
      '267,500',
      '267,000',
      '266,500',
      '266,000',
      '265,500',
      '265,000',
      '264,500',
      '264,000',
      '263,500',
      '263,000',
    ])
    expect(rows('bid').map(priceOf)[0]).toBe('262,000')
    expect(rows('bid').map(priceOf).at(-1)).toBe('257,500')
    // 매도 블록이 매수 블록보다 앞에 온다 (체결가가 가운데) / The ask block precedes the bid block, with the last price between them
    expect(rows()[9]!.classList.contains('down')).toBe(true)
    expect(rows()[10]!.classList.contains('up')).toBe(true)
  })

  it('KR 종목 가격은 소수점 없이 천 단위로 표기한다 / formats KR prices with no decimals', () => {
    const { rows } = renderOrderBook()

    expect(priceOf(rows('ask')[0]!)).toBe('267,500')
    // 잔량은 F1 포매터 그대로 / Quantities come straight from the F1 formatter
    expect(rows('bid')[0]!.querySelector('.orderbook-qty')?.textContent).toBe('400')
  })

  it('US 종목은 소수 2자리로 표기한다 / formats US prices with two decimals', () => {
    vi.mocked(useOrderBook).mockReturnValue(
      hookResult({
        data: {
          symbol: 'AAPL',
          market: 'us',
          price: 245.5,
          entries: [
            { price: 245.75, qty: 300, side: 'ask' },
            { price: 245.25, qty: 150, side: 'bid' },
          ],
          simulated: true,
        },
      }),
    )
    const { rows } = renderOrderBook('AAPL')

    expect(priceOf(rows('ask')[0]!)).toBe('245.75')
    expect(barWidth(rows('bid')[0]!)).toBe(50)
  })

  it('20건보다 적어도 온 만큼만 렌더한다 (길이 가정 금지) / renders however many entries arrive, never assuming twenty', () => {
    vi.mocked(useOrderBook).mockReturnValue(
      hookResult({
        data: {
          symbol: SYMBOL,
          market: 'kr',
          price: 262500,
          entries: [
            { price: 263000, qty: 120, side: 'ask' },
            { price: 263500, qty: 250, side: 'ask' },
            { price: 264000, qty: 90, side: 'ask' },
            { price: 262000, qty: 500, side: 'bid' },
            { price: 261500, qty: 250, side: 'bid' },
          ],
          simulated: true,
        },
      }),
    )
    const { rows } = renderOrderBook()

    expect(rows('ask')).toHaveLength(3)
    expect(rows('bid')).toHaveLength(2)
    expect(barWidth(rows('bid')[0]!)).toBe(100)
    expect(barWidth(rows('ask')[1]!)).toBe(50)
  })

  it('한쪽만 와도 그 쪽만 렌더한다 / one-sided data renders just that side', () => {
    vi.mocked(useOrderBook).mockReturnValue(
      hookResult({
        data: {
          symbol: SYMBOL,
          market: 'kr',
          price: 262500,
          entries: [{ price: 263000, qty: 120, side: 'ask' }],
          simulated: true,
        },
      }),
    )
    const { rows } = renderOrderBook()

    expect(rows('ask')).toHaveLength(1)
    expect(rows('bid')).toHaveLength(0)
    expect(barWidth(rows('ask')[0]!)).toBe(100)
  })

  it('잔량이 전부 0이어도 0으로 나누지 않는다 / never divides by zero when every quantity is 0', () => {
    vi.mocked(useOrderBook).mockReturnValue(
      hookResult({
        data: {
          symbol: SYMBOL,
          market: 'kr',
          price: 262500,
          entries: [
            { price: 263000, qty: 0, side: 'ask' },
            { price: 262000, qty: 0, side: 'bid' },
          ],
          simulated: true,
        },
      }),
    )
    const { rows } = renderOrderBook()

    expect(rows()).toHaveLength(2)
    for (const row of rows()) expect(barWidth(row)).toBe(0)
  })

  it('호가가 비면 빈 상태 문구를 낸다 / states the empty case when there are no entries', () => {
    vi.mocked(useOrderBook).mockReturnValue(
      hookResult({
        data: { symbol: SYMBOL, market: 'kr', price: 262500, entries: [], simulated: true },
      }),
    )
    const { rows } = renderOrderBook()

    expect(screen.getByText('호가 데이터가 없습니다')).toBeTruthy()
    expect(rows()).toHaveLength(0)
  })

  it('로딩 중에는 스피너만 보인다 / shows only a spinner while loading', () => {
    vi.mocked(useOrderBook).mockReturnValue(hookResult({ isLoading: true }))
    const { rows } = renderOrderBook()

    expect(screen.getByRole('status')).toBeTruthy()
    expect(rows()).toHaveLength(0)
  })

  it('실패하면 에러 카드가 뜨고 재시도가 해당 호가 쿼리를 무효화한다 / fails into an error card whose retry invalidates that symbol’s order book', () => {
    vi.mocked(useOrderBook).mockReturnValue(hookResult({ error: new Error('boom') }))
    const { queryClient, rows } = renderOrderBook()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(rows()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['orderbook', SYMBOL] })
  })
})
