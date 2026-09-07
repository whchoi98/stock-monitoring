/**
 * 뉴스 와이어 (시장) — RSS 피드를 목록으로, 언어 탭(전체 / 한국어 / English)과 제목 키워드로 거른다.
 * 항목 렌더와 링크 분기는 `common/NewsList`가, 필터 규칙은 `lib/newsFilter.ts`가 소유한다.
 * The market news wire: the RSS feed as a list, filtered by a language tab (all / Korean / English) and a title keyword.
 * Row rendering and the link fork belong to `common/NewsList`; the filter rule to `lib/newsFilter.ts`.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { useNews } from '../../api/queries.ts'
import { filterNews, NEWS_LANGUAGE_LABEL, type NewsLanguageFilter } from '../../lib/newsFilter.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { NewsList } from '../common/NewsList.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'

const LANGUAGES: NewsLanguageFilter[] = ['all', 'ko', 'en']

export function NewsFeed() {
  const { data, asOf, isLoading, error } = useNews()
  const queryClient = useQueryClient()
  const [language, setLanguage] = useState<NewsLanguageFilter>('all')
  const [query, setQuery] = useState('')

  // 재시도는 이 위젯의 쿼리 키만 무효화한다 — 키는 `api/queries.ts`의 `['news']`와 같아야 한다 / The retry invalidates just this key
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['news'] })
  }

  const items = useMemo(() => data ?? [], [data])
  const shown = useMemo(() => filterNews(items, { language, query }), [items, language, query])
  const filtering = language !== 'all' || query.trim() !== ''

  if (error !== null) return <ErrorCard onRetry={retry} message="뉴스를 불러오지 못했습니다" />

  return (
    <Panel
      id="news-wire"
      eyebrow="NEWS WIRE"
      title="시장 뉴스"
      action={
        <>
          <div className="tabs" role="group" aria-label="뉴스 필터">
            {LANGUAGES.map((value) => (
              <button
                key={value}
                type="button"
                className={value === language ? 'tab tab-active' : 'tab'}
                aria-pressed={value === language}
                onClick={() => setLanguage(value)}
              >
                {NEWS_LANGUAGE_LABEL[value]}
              </button>
            ))}
          </div>
          <input
            className="filter-input"
            type="search"
            aria-label="뉴스 검색"
            placeholder="키워드"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {items.length > 0 && (
            <span className="badge">{filtering ? `${shown.length}/${items.length}건` : `${items.length}건`}</span>
          )}
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
      ) : shown.length === 0 ? (
        <p className="empty panel-pad">조건에 맞는 뉴스가 없습니다</p>
      ) : (
        <NewsList items={shown} />
      )}
    </Panel>
  )
}
