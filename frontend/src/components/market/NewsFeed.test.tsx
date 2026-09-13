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
import { fireEvent, render, screen } from '@testing-library/react'
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

/**
 * `<link>`가 없던 RSS 항목 / An RSS item that had no `<link>`.
 *
 * 백엔드는 제목 없는 항목만 버리므로 빈 링크는 그대로 도착한다 (`app/services/news.py`).
 * The backend drops only untitled items, so an empty link arrives as is (`app/services/news.py`).
 */
const EMPTY_LINK: NewsItem = {
  id: 'empty',
  title: '링크 없는 항목',
  link: '',
  source: '연합뉴스',
  published: '2026-08-03T05:00:00Z',
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
  vi.mocked(useNews).mockReturnValue(hookResult({ data: [WRAPPED, DIRECT, EMPTY_LINK] }))
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

  it('언어 탭과 키워드로 거르고 건수 뱃지를 갱신한다 / filters by language tab and keyword, updating the count badge', () => {
    const { container } = renderNewsFeed()
    const titles = () => Array.from(container.querySelectorAll('.news-title')).map((el) => el.textContent)

    expect(titles()).toHaveLength(3)
    expect(screen.getByText('3건')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(titles()).toEqual([DIRECT.title])
    expect(screen.getByText('1/3건')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '전체' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '뉴스 검색' }), { target: { value: '코스피' } })
    expect(titles()).toEqual([WRAPPED.title])

    fireEvent.change(screen.getByRole('searchbox', { name: '뉴스 검색' }), { target: { value: 'zzz' } })
    expect(titles()).toHaveLength(0)
    expect(screen.getByText('조건에 맞는 뉴스가 없습니다')).toBeTruthy()
    expect(screen.getByText('0/3건')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '뉴스 필터 초기화' }))
    expect(titles()).toHaveLength(3)
  })

  it('빈 링크는 새 탭으로 열지 않는다 (href="" = 현재 페이지 복제) / never opens an empty link in a new tab', () => {
    const { itemLink } = renderNewsFeed()
    const link = itemLink(EMPTY_LINK.title)

    // 새 탭 분기로 갔다면 `href=""`(현재 페이지)를 새 탭으로 여는 것이 전부다
    // Had it taken the new-tab branch, all it would do is open `href=""` — the current page — in a new tab
    expect(link.getAttribute('target')).toBeNull()
    expect(link.getAttribute('href')).not.toBe('')
    // 대신 분석 화면으로 간다 — 그 화면이 빈 url을 "잘못된 접근" 카드로 안내한다 (유료 호출 없음)
    // It goes to the analysis screen instead, which answers an empty url with its "잘못된 접근" card (no paid call)
    const href = link.getAttribute('href') ?? ''
    expect(href.startsWith('/articles?')).toBe(true)
    expect(new URL(href, 'http://h').searchParams.get('url')).toBe('')
  })
})
