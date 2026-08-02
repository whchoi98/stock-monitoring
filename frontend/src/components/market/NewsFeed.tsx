/**
 * 뉴스 사이드바 — RSS 피드를 목록으로 보여주고, 항목을 누르면 기사 AI 분석 화면으로 보낸다.
 * The news sidebar: the RSS feed as a list whose items open the article AI analysis screen.
 *
 * 링크는 `/articles?url=&title=&language=` — 쿼리 파라미터로 실어야 새로고침·공유가 된다 (스펙 6.2 ③).
 * `<Link>`를 쓰므로 실제 `<a href>`가 렌더되고(새 탭/복사 가능), 라우팅은 react-router가 가로챈다.
 * The link is `/articles?url=&title=&language=`: the query parameters are what make a refresh or a shared
 * URL work (spec 6.2 ③). `<Link>` renders a real `<a href>` (new tab, copy) while react-router intercepts
 * the navigation.
 *
 * `/articles` 라우트는 F7에서 생긴다 — 그 전에 누르면 react-router의 no-match 화면이 뜨는 것이 알려진
 * 중간 상태다. The `/articles` route lands in F7; until then a click shows react-router's no-match screen,
 * a known interim state.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { useNews } from '../../api/queries.ts'
import type { NewsItem } from '../../api/types.ts'
import { formatPublished } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

/** 기사 분석 화면 링크 / The link to the article analysis screen */
function articleHref(item: NewsItem): string {
  const params = new URLSearchParams({ url: item.link, title: item.title, language: item.language })
  return `/articles?${params.toString()}`
}

export function NewsFeed() {
  const { data, asOf, isLoading, error } = useNews()
  const queryClient = useQueryClient()

  // F2 훅은 `refetch`를 노출하지 않는다 — 키는 `api/queries.ts`의 `['news']`와 같아야 한다.
  // The F2 hooks expose no `refetch`; this key must mirror `['news']` in `api/queries.ts`.
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['news'] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="뉴스를 불러오지 못했습니다" />

  const items = data ?? []

  return (
    <Card title="뉴스" action={<AsOfBadge asOf={asOf} />}>
      {isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="empty">표시할 뉴스가 없습니다</p>
      ) : (
        <ul className="news-list">
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
