/**
 * 호가창 (ORDER BOOK) — 매도 호가를 위, 현재가 구분행, 매수 호가를 아래에 쌓고 각 단계의 잔량을 막대로, 맨 아래에
 * 매도/매수 잔량 합계와 매수 비중 막대를 보여준다 (한국 HTS 호가창 문법).
 * The order book: asks stacked above, a last-price divider, bids below, each level's quantity as a bar, and the ask
 * and bid totals with a bid-share bar at the bottom (the Korean HTS idiom).
 *
 * **시뮬레이션 데이터다** (`OrderBookData.simulated`는 항상 true) — 실시간 호가 소스가 없어 백엔드가 현재가에서
 * 파생시킨 값이므로 `SimulatedBadge` 표시가 의무다.
 * **This is simulated data** (`OrderBookData.simulated` is always true): with no live source the backend derives it
 * from the last price, which makes the `SimulatedBadge` mandatory.
 *
 * **길이를 가정하지 않는다**: 보통 매도 10 + 매수 10이지만 엣지 케이스에서는 더 적다 — `entries`를 side로 나눠 온
 * 만큼만 렌더한다. 색은 한국 관례다: 매도 = 하락색, 매수 = 상승색. 잔량 막대는 **매도·매수를 합친 최대 잔량**을
 * 기준으로 하므로 양쪽 깊이를 한 눈금으로 비교할 수 있다.
 * **No length is assumed**: entries are split by side and rendered as they arrive. Colours follow the Korean
 * convention (asks down, bids up), and bars scale to the peak quantity **across both sides** so the depths read on one
 * scale.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useOrderBook } from '../../api/queries.ts'
import type { Market, OrderBookEntry } from '../../api/types.ts'
import { formatPrice, formatVolume, type Currency } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { SimulatedBadge } from '../common/SimulatedBadge.tsx'
import { Spinner } from '../common/Spinner.tsx'

/**
 * 시장의 통화 — 호가 응답은 `market`만 담는다. 백엔드 접미사 규칙의 복제가 아니라 두 값 사이의 1:1 대응이다.
 * A market's currency; the response carries `market` only. Not a copy of the backend's suffix rule but the 1:1
 * correspondence between its two outputs.
 */
const CURRENCY_OF: Record<Market, Currency> = { us: 'USD', kr: 'KRW' }

/** 매도는 위(높은 값부터), 매수도 높은 값부터 — 현재가가 두 블록 사이에 온다 / Both sides high price first, with the last price between them */
function descending(entries: OrderBookEntry[], side: OrderBookEntry['side']): OrderBookEntry[] {
  return entries.filter((entry) => entry.side === side).sort((a, b) => b.price - a.price)
}

function sumQty(entries: OrderBookEntry[]): number {
  return entries.reduce((total, entry) => total + entry.qty, 0)
}

export interface OrderBookProps {
  /** 종목 심볼 — 그대로 훅에 넘긴다 / The symbol, handed straight to the hook */
  symbol: string
}

export function OrderBook({ symbol }: OrderBookProps) {
  const { data, asOf, isLoading, error } = useOrderBook(symbol)
  const queryClient = useQueryClient()

  // 재시도는 이 위젯의 쿼리 키만 무효화한다 — `api/queries.ts`의 `['orderbook', symbol]` / The retry invalidates just this key
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['orderbook', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="호가를 불러오지 못했습니다" />

  const entries = data?.entries ?? []
  const asks = descending(entries, 'ask')
  const bids = descending(entries, 'bid')
  // 0으로 나누지 않는다 — 잔량이 전부 0이면 막대는 길이 0이다 / Never divide by zero: all-zero quantities yield zero-length bars
  const peak = Math.max(...entries.map((entry) => entry.qty), 0)
  const askTotal = sumQty(asks)
  const bidTotal = sumQty(bids)
  const total = askTotal + bidTotal

  const row = (entry: OrderBookEntry, index: number, currency: Currency) => (
    /*
     * 같은 가격이 두 번 올 수 있으므로(시뮬레이션 틱이 겹치는 엣지 케이스) 가격은 키가 될 수 없다 — side + 위치가 정체다.
     * A price can repeat (overlapping simulated ticks), so side plus index is the row's identity.
     */
    <li
      key={`${entry.side}-${index}`}
      className={`orderbook-row orderbook-row-${entry.side} ${entry.side === 'ask' ? 'down' : 'up'}`}
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
  )

  return (
    <Panel
      eyebrow="ORDER BOOK"
      title="호가"
      action={
        <>
          <SimulatedBadge />
          <AsOfBadge asOf={asOf} />
        </>
      }
      flush
    >
      {isLoading ? (
        <div className="panel-pad">
          <Spinner />
        </div>
      ) : data === undefined || entries.length === 0 ? (
        <p className="empty panel-pad">호가 데이터가 없습니다</p>
      ) : (
        <div className="orderbook-wrap">
          <ul className="orderbook">
            {asks.map((entry, index) => row(entry, index, CURRENCY_OF[data.market]))}
            {/* 현재가 구분행 — `.orderbook-row`가 아니므로 행 수에 들지 않는다 / The last-price divider; not an `.orderbook-row`, so it never counts as a level */}
            <li className="orderbook-mid">
              <span className="orderbook-mid-label">현재가</span>
              <span className="orderbook-mid-price">
                {formatPrice(data.price, CURRENCY_OF[data.market])}
              </span>
            </li>
            {bids.map((entry, index) => row(entry, index, CURRENCY_OF[data.market]))}
          </ul>
          <div className="orderbook-totals">
            <div className="ob-total-row">
              <span className="down">매도잔량 {formatVolume(askTotal)}</span>
              <span className="up">매수잔량 {formatVolume(bidTotal)}</span>
            </div>
            {/* 매수 비중 막대 — 잔량이 전부 0이면 비율이 없어 그리지 않는다 / The bid-share bar; all-zero quantities have no ratio, so none is drawn */}
            {total > 0 && (
              <div className="ob-ratio" aria-hidden="true">
                <span className="ob-ratio-fill" style={{ width: `${(bidTotal / total) * 100}%` }} />
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}
