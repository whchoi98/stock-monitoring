/**
 * 뉴스 와이어 (시장) — RSS 피드를 목록으로. 항목 렌더와 링크 분기는 `common/NewsList`가 소유한다.
 * The market news wire: the RSS feed as a list; row rendering and the link fork belong to `common/NewsList`.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useNews } from '../../api/queries.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { NewsList } from '../common/NewsList.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'

export function NewsFeed() {
  const { data, asOf, isLoading, error } = useNews()
  const queryClient = useQueryClient()

  // 재시도는 이 위젯의 쿼리 키만 무효화한다 — 키는 `api/queries.ts`의 `['news']`와 같아야 한다 / The retry invalidates just this key
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['news'] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="뉴스를 불러오지 못했습니다" />

  const items = data ?? []

  return (
    <Panel
      eyebrow="NEWS WIRE"
      title="시장 뉴스"
      action={
        <>
          {items.length > 0 && <span className="badge">{items.length}건</span>}
          <AsOfBadge asOf={asOf} />
        </>
      }
      flush
    >
      {isLoading ? (
        <div className="panel-pad">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="empty panel-pad">표시할 뉴스가 없습니다</p>
      ) : (
        <NewsList items={items} />
      )}
    </Panel>
  )
}
