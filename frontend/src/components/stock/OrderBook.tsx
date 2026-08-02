/**
 * 호가창 — 매도 호가를 위, 매수 호가를 아래에 쌓고 각 단계의 잔량을 막대로 보여준다.
 * The order book: asks stacked above, bids below, each level's resting quantity drawn as a bar.
 *
 * **시뮬레이션 데이터다** (`OrderBookData.simulated`는 항상 true) — 실시간 호가 소스가 없어 백엔드가
 * 현재가에서 파생시킨 값이므로 `SimulatedBadge` 표시가 의무다.
 * **This is simulated data** (`OrderBookData.simulated` is always true): with no live order-book source the
 * backend derives it from the last price, which makes the `SimulatedBadge` mandatory.
 *
 * **길이를 가정하지 않는다**: 보통 매도 10 + 매수 10이지만 엣지 케이스에서는 더 적다
 * (`api/types.ts`). 그래서 `entries`를 side로 나눠 온 만큼만 렌더한다 — 20행을 인덱스로 집지 않는다.
 * **No length is assumed**: normally ten asks plus ten bids, but edge cases yield fewer (see
 * `api/types.ts`), so `entries` is split by side and rendered as it arrives — never indexed as 20 rows.
 *
 * 색은 한국 관례다: 매도 = 하락색, 매수 = 상승색. 잔량 막대는 **매도·매수를 합친 최대 잔량**을 기준으로
 * 하므로 양쪽 깊이를 한 눈금으로 비교할 수 있다 (side별로 정규화하면 100% 행이 두 개 생겨 의미가 흐려진다).
 * Colours follow the Korean convention: asks take the down colour, bids the up colour. A bar is scaled to
 * the peak quantity **across both sides**, so the two depths read on one scale (normalising per side would
 * produce two full bars and lose that meaning).
 */
import { useQueryClient } from '@tanstack/react-query'

import { useOrderBook } from '../../api/queries.ts'
import type { Market, OrderBookEntry } from '../../api/types.ts'
import { formatPrice, formatVolume, type Currency } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { SimulatedBadge } from '../common/SimulatedBadge.tsx'
import { Spinner } from '../common/Spinner.tsx'

/**
 * 시장의 통화 / A market's currency.
 *
 * 호가 응답은 `market`만 담고 통화는 담지 않는다. 이건 백엔드의 접미사 판별 규칙
 * (`services/fundamentals.py`의 `_market_and_currency`)을 복제하는 것이 아니라 그 결과인 두 값 사이의
 * 1:1 대응이다 — 심볼을 다시 해석하지 않는다.
 * The order-book response carries `market` but no currency. This is not a copy of the backend's suffix
 * rule (`_market_and_currency` in `services/fundamentals.py`) but the 1:1 correspondence between its two
 * outputs; the symbol is never re-parsed here.
 */
const CURRENCY_OF: Record<Market, Currency> = { us: 'USD', kr: 'KRW' }

/** 매도는 위(높은 값부터), 매수도 높은 값부터 — 체결가가 두 블록 사이에 온다 / Asks above and bids below, both high price first, with the last price between them */
function descending(entries: OrderBookEntry[], side: OrderBookEntry['side']): OrderBookEntry[] {
  return entries.filter((entry) => entry.side === side).sort((a, b) => b.price - a.price)
}

export interface OrderBookProps {
  /** 종목 심볼 — 그대로 F2 훅에 넘긴다 / The symbol, handed straight to the F2 hook */
  symbol: string
}

export function OrderBook({ symbol }: OrderBookProps) {
  const { data, asOf, isLoading, error } = useOrderBook(symbol)
  const queryClient = useQueryClient()

  /*
   * F2 훅은 `refetch`를 노출하지 않으므로(계약: `{data, asOf, marketOpen, isLoading, error}`)
   * 재시도는 이 위젯의 쿼리 키만 무효화한다 — 키는 `api/queries.ts`의 `['orderbook', symbol]`과 같아야 한다.
   * The F2 hooks expose no `refetch`, so a retry invalidates just this widget's key, which must mirror
   * `['orderbook', symbol]` in `api/queries.ts`.
   */
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['orderbook', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="호가를 불러오지 못했습니다" />

  const entries = data?.entries ?? []
  // 데이터가 없으면 행도 없으므로 이 기본값으로 포맷되는 가격은 존재하지 않는다 / With no data there are no rows, so no price is ever formatted with this fallback
  const currency = data === undefined ? 'USD' : CURRENCY_OF[data.market]
  const rows = [...descending(entries, 'ask'), ...descending(entries, 'bid')]
  // 0으로 나누지 않는다 — 잔량이 전부 0이면 막대는 길이 0이다 / Never divide by zero: all-zero quantities yield zero-length bars
  const peak = Math.max(...entries.map((entry) => entry.qty), 0)

  return (
    <Card
      title="호가"
      action={
        <>
          <SimulatedBadge />
          <AsOfBadge asOf={asOf} />
        </>
      }
    >
      {isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="empty">호가 데이터가 없습니다</p>
      ) : (
        <ul className="orderbook">
          {rows.map((entry, index) => (
            /*
             * 같은 가격이 두 번 올 수 있으므로(시뮬레이션 틱이 겹치는 엣지 케이스) 가격은 키가 될 수 없다.
             * 정렬된 배열의 위치가 이 행의 정체이므로 side + 위치를 키로 쓴다.
             * A price can repeat (overlapping simulated ticks), so it cannot be the key; a row's identity
             * is its position in the sorted array, hence side plus index.
             */
            <li
              key={`${entry.side}-${index}`}
              className={`orderbook-row orderbook-row-${entry.side} ${
                entry.side === 'ask' ? 'down' : 'up'
              }`}
            >
              <span className="orderbook-price">{formatPrice(entry.price, currency)}</span>
              <span className="orderbook-track">
                <span
                  className="orderbook-fill"
                  style={{ width: peak === 0 ? '0%' : `${(entry.qty / peak) * 100}%` }}
                />
              </span>
              <span className="orderbook-qty">{formatVolume(entry.qty)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
