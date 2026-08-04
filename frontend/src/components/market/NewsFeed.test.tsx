/**
 * NewsFeed 테스트 — 시장 뉴스도 종목 뉴스와 같은 링크 분기를 쓴다는 것을 고정한다.
 * NewsFeed tests, pinning that the market feed splits its links exactly as the per-stock feed does.
 *
 * 시장 뉴스는 대부분 발행사 직접 URL이지만 피드 구성이 바뀌면 래퍼가 섞일 수 있다 — 두 목록이 같은
 * `lib/articleLink.ts` 판정을 쓰므로 여기서도 분기를 검증한다 (한쪽만 고쳐지는 회귀 방지).
 * The market feed is mostly publisher URLs, but a feed change can mix wrappers in. Both lists share the
 * `lib/articleLink.ts` verdict, so the split is verified here too — that is what stops one list from being
 * fixed alone.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useNews } from '../../api/queries.ts'
import type { NewsItem } from '../../api/types.ts'
import { NewsFeed } from './NewsFeed.tsx'

vi.mock('../../api/queries.ts', () => ({ useNews: vi.fn() }))

/** 본문 추출이 불가능한 Google News 래퍼 / A Google News wrapper we cannot extract */
const WRAPPED: NewsItem = {
  id: 'wrapped',
  title: '코스피 사상 최고치',
  link: 'https://news.google.com/rss/articles/CBMiQXdyYXBwZWQ?oc=5',
  source: '연합뉴스',
  published: '2026-08-03T03:00:00Z',
  language: 'ko',
}

/** 발행사 직접 URL / A publisher URL */
const DIRECT: NewsItem = {
  id: 'direct',
  title: 'Fed holds rates steady',
  link: 'https://finance.yahoo.com/news/fed-holds.html',
  source: 'Yahoo Finance',
  published: '2026-08-03T04:00:00Z',
  language: 'en',
}

function hookResult(over: Partial<QueryResult<NewsItem[]>>): QueryResult<NewsItem[]> {
  return {
    data: undefined,
    asOf: undefined,
    marketOpen: undefined,
    isLoading: false,
    error: null,
    ...over,
  }
}

function renderNewsFeed() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <NewsFeed />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  const itemLink = (title: string): HTMLAnchorElement => {
    const anchors = Array.from(view.container.querySelectorAll<HTMLAnchorElement>('a.news-item'))
    const found = anchors.find((a) => a.querySelector('.news-title')?.textContent === title)
    if (found === undefined) throw new Error(`항목이 없다 / no item titled ${title}`)
    return found
  }
  return { ...view, itemLink }
}

beforeEach(() => {
  vi.mocked(useNews).mockReturnValue(hookResult({ data: [WRAPPED, DIRECT] }))
})

describe('NewsFeed', () => {
  it('분석 불가 항목은 원문을 새 탭으로 열고 표식을 붙인다 / opens an unanalyzable item in a new tab and marks it', () => {
    const { itemLink } = renderNewsFeed()
    const link = itemLink(WRAPPED.title)

    expect(link.getAttribute('href')).toBe(WRAPPED.link)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
    expect(link.querySelector('.news-meta')?.textContent).toContain('원문 보기')
  })

  it('직접 URL 항목은 기존대로 분석 화면으로 링크한다 / keeps routing a direct-URL item to the analysis screen', () => {
    const { itemLink } = renderNewsFeed()
    const link = itemLink(DIRECT.title)

    const href = link.getAttribute('href') ?? ''
    expect(href.startsWith('/articles?')).toBe(true)
    expect(new URL(href, 'http://h').searchParams.get('url')).toBe(DIRECT.link)
    expect(link.getAttribute('target')).toBeNull()
    expect(link.querySelector('.news-meta')?.textContent).not.toContain('원문 보기')
  })
})
