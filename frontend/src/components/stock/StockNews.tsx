/**
 * 종목 뉴스 — 이 종목의 RSS 피드(최대 8건)를 목록으로, 항목을 누르면 기사 AI 분석 화면으로 보낸다.
 * The per-stock news feed: this symbol's RSS items (up to eight) as a list whose entries open the article AI
 * analysis screen.
 *
 * 단, 본문 추출이 불가능한 링크(KR 종목뉴스의 Google News 래퍼)는 분석 화면 대신 원문을 새 탭으로 연다 —
 * 판정과 링크는 `lib/articleLink.ts`가 소유하고 `NewsFeed`(F4)와 공유한다.
 * Links we cannot extract (the Google News wrappers behind KR per-symbol news) open the source in a new tab
 * instead; the verdict and the link both live in `lib/articleLink.ts`, shared with `NewsFeed` (F4).
 *
 * 시장 뉴스(F4 `NewsFeed`)와 같은 목록 스타일·같은 링크 형식을 쓴다 — 발행 시각 표기는 `lib/format.ts`의
 * `formatPublished`를 공유한다. 폴링 주기는 뉴스 계열이라 120초다 (`useStockNews`).
 * It reuses the market feed's (F4's `NewsFeed`) list styling and link shape, and shares the publication-time
 * wording through `formatPublished` in `lib/format.ts`. Being news, it polls at 120s (`useStockNews`).
 */
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { useStockNews } from '../../api/queries.ts'
import { articleHref, isAnalyzable } from '../../lib/articleLink.ts'
import { formatPublished } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

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
            const analyzable = isAnalyzable(item)
            /*
             * 항목 내용은 두 분기가 그대로 공유한다 — 어디로 가든 시각·접근성이 같아야 한다.
             * Both branches share this body verbatim: wherever the click lands, it must look and read the same.
             */
            const body = (
              <>
                <span className="news-title">{item.title}</span>
                <span className="news-meta">
                  {item.source}
                  {published !== null && ` · ${published}`}
                  {/* 분석 화면이 아니라 외부로 나간다는 표식 / The marker for leaving the app instead of analysing */}
                  {!analyzable && ' · 원문 보기'}
                </span>
              </>
            )
            return (
              <li key={item.id}>
                {analyzable ? (
                  <Link className="news-item" to={articleHref(item)}>
                    {body}
                  </Link>
                ) : (
                  /* 원문은 외부 사이트다 — 새 탭으로 열고 rel로 레퍼러/opener를 끊는다 / Off-site: a new tab, with the referrer and opener cut by rel */
                  <a className="news-item" href={item.link} target="_blank" rel="noreferrer">
                    {body}
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
