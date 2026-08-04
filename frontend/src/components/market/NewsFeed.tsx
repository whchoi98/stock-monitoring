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
 * 단, 본문 추출이 불가능한 링크(Google News 래퍼)는 분석 화면 대신 원문을 새 탭으로 연다 — 판정과 링크는
 * `lib/articleLink.ts`가 소유하고 종목 뉴스(`StockNews`)와 공유한다.
 * Links we cannot extract (Google News wrappers) open the source in a new tab instead; the verdict and the
 * link both live in `lib/articleLink.ts`, shared with the per-stock feed (`StockNews`).
 */
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { useNews } from '../../api/queries.ts'
import { articleHref, isAnalyzable } from '../../lib/articleLink.ts'
import { formatPublished } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

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
