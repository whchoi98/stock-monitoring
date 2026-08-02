/**
 * 종목 뉴스 — 이 종목의 RSS 피드(최대 8건)를 목록으로, 항목을 누르면 기사 AI 분석 화면으로 보낸다.
 * The per-stock news feed: this symbol's RSS items (up to eight) as a list whose entries open the article AI
 * analysis screen.
 *
 * 시장 뉴스(F4 `NewsFeed`)와 같은 목록 스타일·같은 링크 형식을 쓴다 — 발행 시각 표기는 `lib/format.ts`의
 * `formatPublished`를 공유한다. 폴링 주기는 뉴스 계열이라 120초다 (`useStockNews`).
 * It reuses the market feed's (F4's `NewsFeed`) list styling and link shape, and shares the publication-time
 * wording through `formatPublished` in `lib/format.ts`. Being news, it polls at 120s (`useStockNews`).
 */
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { useStockNews } from '../../api/queries.ts'
import type { NewsItem } from '../../api/types.ts'
import { formatPublished } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

/**
 * 기사 분석 화면 링크 / The link to the article analysis screen.
 *
 * `NewsFeed`(F4)에 같은 함수가 있다. 쿼리 파라미터 이름은 `/articles`와의 계약이므로 F7이 그 라우트를
 * 만들 때 한 곳으로 모으는 것이 옳다 — 지금 공용 파일로 빼면 라우트 소유자가 없는 채로 헬퍼가 떠돈다.
 * `NewsFeed` (F4) holds the same function. The parameter names are a contract with `/articles`, so the right
 * time to centralise them is when F7 builds that route; extracting a shared helper now would leave it
 * ownerless.
 */
function articleHref(item: NewsItem): string {
  const params = new URLSearchParams({ url: item.link, title: item.title, language: item.language })
  return `/articles?${params.toString()}`
}

export interface StockNewsProps {
  /** 종목 심볼 — 그대로 F2 훅에 넘긴다 / The symbol, handed straight to the F2 hook */
  symbol: string
}

export function StockNews({ symbol }: StockNewsProps) {
  const { data, asOf, isLoading, error } = useStockNews(symbol)
  const queryClient = useQueryClient()

  /*
   * 재시도는 이 위젯의 쿼리 키만 무효화한다 — 키는 `api/queries.ts`의 `['stock-news', symbol]`과 같아야 한다.
   * A retry invalidates just this widget's key, which must mirror `['stock-news', symbol]` in `api/queries.ts`.
   */
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock-news', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="종목 뉴스를 불러오지 못했습니다" />

  const items = data ?? []

  return (
    <Card title="종목 뉴스" action={<AsOfBadge asOf={asOf} />}>
      {isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="empty">이 종목의 뉴스가 없습니다</p>
      ) : (
        <ul className="news-list news-list-inline">
          {items.map((item) => {
            const published = formatPublished(item.published)
            return (
              <li key={item.id}>
                <Link className="news-item" to={articleHref(item)}>
                  <span className="news-title">{item.title}</span>
                  <span className="news-meta">
                    {item.source}
                    {published !== null && ` · ${published}`}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
