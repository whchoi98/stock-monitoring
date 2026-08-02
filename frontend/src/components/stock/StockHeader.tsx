/**
 * 종목 헤더 — Toss형: 종목명/심볼 → 현재가(28px bold) → "어제보다 ▲+N (N%)" → 1일/52주 게이지.
 * The stock header, Toss-style: name and symbol, the price at 28px bold, "어제보다 ▲+N (N%)", and the
 * 1-day / 52-week gauges (spec 6.2 ②).
 *
 * 카드 안이 아니라 페이지 머리다 (`<h1>`은 이 페이지의 제목이다). 데이터는 F2 훅으로 직접 가져가고,
 * 같은 쿼리 키(`['stock', symbol]`)를 쓰는 다른 위젯들과 요청 하나를 공유한다 — F4가 개요 3위젯에 세운 관례다.
 * It is the page's head rather than a card (its `<h1>` is this page's title). It fetches through the F2 hook
 * and shares one request with the other widgets on the same query key (`['stock', symbol]`), following the
 * convention F4 set for the three overview widgets.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useStock } from '../../api/queries.ts'
import type { Market } from '../../api/types.ts'
import { formatPrice } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ChangeText } from '../common/ChangeText.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Week52Bar } from './Week52Bar.tsx'

const MARKET_LABEL: Record<Market, string> = { us: '미국', kr: '한국' }

export interface StockHeaderProps {
  /** 종목 심볼 — 그대로 F2 훅에 넘긴다 / The symbol, handed straight to the F2 hook */
  symbol: string
}

export function StockHeader({ symbol }: StockHeaderProps) {
  const { data, asOf, isLoading, error } = useStock(symbol)
  const queryClient = useQueryClient()

  /*
   * F2 훅은 `refetch`를 노출하지 않으므로 재시도는 쿼리 키를 무효화한다 — 키는 `api/queries.ts`의
   * `['stock', symbol]`과 같아야 한다. 상세를 쓰는 세 위젯(헤더/핵심지표/기간수익률)이 이 키를
   * 공유하므로 한 번의 재시도로 함께 복구된다.
   * The F2 hooks expose no `refetch`, so a retry invalidates the query key, which must mirror
   * `['stock', symbol]` in `api/queries.ts`. The three detail widgets (header, fundamentals, returns) share
   * that key, so one retry heals all of them.
   */
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock', symbol] })
  }

  if (error !== null) {
    return <ErrorCard onRetry={retry} message={`${symbol} 정보를 불러오지 못했습니다`} />
  }

  if (isLoading || data === undefined) {
    return (
      <Card title={symbol}>
        <Spinner />
      </Card>
    )
  }

  return (
    <header className="detail-header">
      <div className="detail-identity">
        <h1 className="detail-name">{data.name}</h1>
        <p className="detail-meta">
          {data.symbol} · {MARKET_LABEL[data.market]}
          {data.sector !== '' && ` · ${data.sector}`}
        </p>
      </div>

      <div className="detail-quote">
        <p className="detail-price">{formatPrice(data.price, data.currency)}</p>
        {/*
          "어제보다"는 전일 종가 대비라는 뜻이다 — `change`/`change_pct`가 바로 그 값이다
          (`day_change`/`day_change_pct`는 TUI 호환용 미러 필드다).
          "어제보다" means "against yesterday's close", which is exactly what `change`/`change_pct` hold
          (`day_change`/`day_change_pct` mirror them for TUI compatibility).
        */}
        <p className="detail-change">
          어제보다{' '}
          <ChangeText value={data.change} pct={data.change_pct} currency={data.currency} />
        </p>
        <AsOfBadge asOf={asOf} />
      </div>

      <div className="detail-gauges">
        <Week52Bar
          label="1일"
          low={data.low}
          high={data.high}
          price={data.price}
          currency={data.currency}
        />
        <Week52Bar
          label="52주"
          low={data.week52_low}
          high={data.week52_high}
          price={data.price}
          currency={data.currency}
        />
      </div>
    </header>
  )
}
