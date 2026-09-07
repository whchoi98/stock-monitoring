/**
 * 워치리스트 레일 — 종목 화면 좌측. 한 시장의 종목을 밀집 행으로 늘어놓고 현재 종목을 강조한다. 행을 누르면 그 종목으로
 * 전환된다 (터미널의 기본 탐색 동작).
 * The watchlist rail on the stock screen's left: one market's stocks as dense rows with the current symbol
 * highlighted; a row click switches to that symbol (the terminal's basic navigation).
 *
 * 시장은 종목 상세가 준 `market`으로 시작한다 — 심볼 접미사로 추측하지 않는다 (백엔드의 시장 분류를 프론트에 복제하지
 * 않기 위해). 안의 토글로 다른 시장도 볼 수 있다. 쿼리 키 `['quotes', market]`는 시세 표·검색과 공유한다.
 * The market starts from the detail's `market`, never guessed from the symbol suffix (that would copy the backend's
 * classification into the frontend). The toggle inside shows the other market too. The `['quotes', market]` key is
 * shared with the quote table and the search.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { useQuotes } from '../../api/queries.ts'
import type { Market } from '../../api/types.ts'
import { arrow, changeClass, formatPct, formatPrice } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { MARKET_LABEL } from '../../lib/markets.ts'
import { MarketTabs } from '../common/MarketTabs.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'

export interface WatchlistProps {
  /** 처음 보여줄 시장 — 현재 종목의 시장 / The market to show first: the current symbol's */
  initialMarket: Market
  /** 강조할 현재 종목 / The current symbol to highlight */
  selected: string
}

export function Watchlist({ initialMarket, selected }: WatchlistProps) {
  const [market, setMarket] = useState<Market>(initialMarket)
  const { data, asOf, isLoading, error } = useQuotes(market)
  const queryClient = useQueryClient()
  const selectedRef = useRef<HTMLAnchorElement | null>(null)

  // 재시도는 이 시장의 시세 키만 무효화한다 / The retry invalidates this market's quotes key alone
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['quotes', market] })
  }

  /*
   * 현재 종목 행이 보이게 스크롤한다 — 50행 목록에서 강조 행이 화면 밖에 있으면 강조가 없는 것과 같다.
   * jsdom에는 `scrollIntoView`가 없으므로 존재를 확인한다.
   * Scroll the current row into view: in a 50-row list a highlight off-screen is no highlight. jsdom has no
   * `scrollIntoView`, hence the guard.
   */
  useEffect(() => {
    const row = selectedRef.current
    if (row !== null && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' })
    }
  }, [selected, data])

  const rows = data ?? []

  return (
    <Panel
      eyebrow="WATCHLIST"
      // 제목은 두지 않는다 — 240px 머리에 eyebrow·탭·뱃지가 전부이고, 시장은 탭이 이미 말한다 / No title: at 240px the eyebrow, tabs and badge fill the head, and the tabs already name the market
      action={
        <>
          <MarketTabs value={market} onChange={setMarket} />
          <AsOfBadge asOf={asOf} />
        </>
      }
      flush
    >
      {error !== null ? (
        <ErrorCard onRetry={retry} message={`${MARKET_LABEL[market]} 종목을 불러오지 못했습니다`} />
      ) : isLoading ? (
        <div className="panel-pad">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <p className="empty panel-pad">표시할 종목이 없습니다</p>
      ) : (
        <ul className="wl-list">
          {rows.map((quote) => {
            const isSelected = quote.symbol === selected
            const kind = changeClass(quote.change)
            return (
              <li key={quote.symbol}>
                <Link
                  ref={isSelected ? selectedRef : undefined}
                  className={isSelected ? 'wl-row wl-selected' : 'wl-row'}
                  aria-current={isSelected ? 'page' : undefined}
                  to={`/stocks/${quote.symbol}`}
                >
                  <span className="wl-symbol">{quote.symbol}</span>
                  <span className="wl-price">{formatPrice(quote.price, quote.currency)}</span>
                  <span className="wl-name" title={quote.name}>
                    {quote.name}
                  </span>
                  <span className={`wl-pct ${kind}`}>
                    {kind === 'flat' ? arrow(quote.change) : `${arrow(quote.change)}${formatPct(quote.change_pct)}`}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
