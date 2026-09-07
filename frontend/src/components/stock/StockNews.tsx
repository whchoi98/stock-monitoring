/**
 * 뉴스 와이어 (종목) — 이 종목의 RSS 피드(최대 8건). 항목 렌더와 링크 분기는 `common/NewsList`가 소유한다.
 * The per-stock news wire: this symbol's RSS items (up to eight); rows and the link fork belong to `common/NewsList`.
 *
 * 폴링 주기는 뉴스 계열이라 120초다 (`useStockNews`). Polling is the news cadence, 120s (`useStockNews`).
 */
import { useQueryClient } from '@tanstack/react-query'

import { useStockNews } from '../../api/queries.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { NewsList } from '../common/NewsList.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'

export interface StockNewsProps {
  /** 종목 심볼 — 그대로 훅에 넘긴다 / The symbol, handed straight to the hook */
  symbol: string
}

export function StockNews({ symbol }: StockNewsProps) {
  const { data, asOf, isLoading, error } = useStockNews(symbol)
  const queryClient = useQueryClient()

  // 재시도는 이 위젯의 쿼리 키만 무효화한다 — `api/queries.ts`의 `['stock-news', symbol]` / The retry invalidates just this key
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock-news', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="종목 뉴스를 불러오지 못했습니다" />

  const items = data ?? []

  return (
    <Panel eyebrow="NEWS WIRE" title="종목 뉴스" action={<AsOfBadge asOf={asOf} />} flush>
      {isLoading ? (
        <div className="panel-pad">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="empty panel-pad">이 종목의 뉴스가 없습니다</p>
      ) : (
        <NewsList items={items} />
      )}
    </Panel>
  )
}
