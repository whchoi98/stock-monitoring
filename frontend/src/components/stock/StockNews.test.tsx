/**
 * StockNews 테스트 — 분석 가능 항목과 분석 불가 항목의 링크 분기를 고정한다.
 * StockNews tests, pinning the link split between analyzable and unanalyzable items.
 *
 * **왜 이 테스트가 있는가** (2026-08-03 라이브 버그): KR 종목뉴스는 Google News 검색 RSS라 링크가
 * `news.google.com/rss/articles/...` 래퍼이고, 그 URL은 실기사가 아니라 Google JS 셸이라 본문 추출이
 * 불가능하다 — 분석 화면으로 보내면 백엔드 502로 매번 막다른 길이었다. 그래서 그런 항목은 원문을 새
 * 탭으로 연다는 것이 계약이다.
 * **Why this test exists** (live bug, 2026-08-03): KR per-symbol news comes from Google News search RSS, so
 * its links are `news.google.com/rss/articles/...` wrappers pointing at a Google JS shell rather than the real
 * article — routing them to the analysis screen dead-ended on a backend 502 every time. The contract is
 * therefore that such items open the source in a new tab.
 *
 * F2 훅(`useStockNews`)은 `vi.mock`으로 고정한다. `MemoryRouter`는 `<Link>`가, `QueryClientProvider`는
 * 재시도 버튼의 `useQueryClient()`가 요구한다.
 * The F2 hook (`useStockNews`) is pinned with `vi.mock`. `MemoryRouter` is what `<Link>` needs and
 * `QueryClientProvider` what the retry button's `useQueryClient()` needs.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { QueryResult } from '../../api/queries.ts'
import { useStockNews } from '../../api/queries.ts'
import type { NewsItem } from '../../api/types.ts'
import { StockNews } from './StockNews.tsx'

vi.mock('../../api/queries.ts', () => ({ useStockNews: vi.fn() }))

const SYMBOL = '005930.KS'

/** KR 종목뉴스의 실제 형태 — Google News 검색 RSS 래퍼 / The real shape of KR news: a Google News search RSS wrapper */
const WRAPPED: NewsItem = {
  id: 'wrapped',
  title: '삼성전자 3분기 실적 발표',
  link: 'https://news.google.com/rss/articles/CBMiK2h0dHBzOi8vZXhhbXBsZS5rcg?oc=5',
  source: '한국경제',
  published: '2026-08-03T01:00:00Z',
  language: 'ko',
}

/** US 종목뉴스의 형태 — 발행사 직접 URL / The shape of US news: a publisher URL we can extract */
const DIRECT: NewsItem = {
  id: 'direct',
  title: 'Apple beats estimates',
  link: 'https://finance.yahoo.com/news/apple-beats.html',
  source: 'Yahoo Finance',
  published: '2026-08-03T02:00:00Z',
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

function renderStockNews() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <StockNews symbol={SYMBOL} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  /** 제목으로 목록 항목 앵커를 집는다 / Pick a list-item anchor by its title */
  const itemLink = (title: string): HTMLAnchorElement => {
    const anchors = Array.from(view.container.querySelectorAll<HTMLAnchorElement>('a.news-item'))
    const found = anchors.find((a) => a.querySelector('.news-title')?.textContent === title)
    if (found === undefined) throw new Error(`항목이 없다 / no item titled ${title}`)
    return found
  }
  return { ...view, itemLink }
}

beforeEach(() => {
  vi.mocked(useStockNews).mockReturnValue(hookResult({ data: [WRAPPED, DIRECT] }))
})

describe('StockNews', () => {
  it('분석 불가(Google News) 항목은 원문을 새 탭으로 연다 / opens an unanalyzable (Google News) item in a new tab', () => {
    const { itemLink } = renderStockNews()
    const link = itemLink(WRAPPED.title)

    // 원문 URL 그대로 — `/articles` 라우트로 가지 않는다 / The source URL itself, never the `/articles` route
    expect(link.getAttribute('href')).toBe(WRAPPED.link)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it('분석 불가 항목에 원문으로 나간다는 표식을 붙인다 / marks the unanalyzable item as leaving for the source', () => {
    const { itemLink } = renderStockNews()

    expect(itemLink(WRAPPED.title).querySelector('.news-meta')?.textContent).toContain('원문 보기')
    // 분석되는 항목에는 그 표식이 없다 / The analyzable item carries no such marker
    expect(itemLink(DIRECT.title).querySelector('.news-meta')?.textContent).not.toContain(
      '원문 보기',
    )
  })

  it('직접 URL 항목은 기존대로 분석 화면으로 링크한다 / keeps routing a direct-URL item to the analysis screen', () => {
    const { itemLink } = renderStockNews()
    const link = itemLink(DIRECT.title)

    const href = link.getAttribute('href') ?? ''
    expect(href.startsWith('/articles?')).toBe(true)
    expect(new URL(href, 'http://h').searchParams.get('url')).toBe(DIRECT.link)
    // 같은 탭 라우팅이므로 새 탭 속성이 없다 / Same-tab routing, so no new-tab attributes
    expect(link.getAttribute('target')).toBeNull()
  })

  it('두 분기가 같은 목록 스타일을 쓴다 / both branches reuse the same list styling', () => {
    const { container, itemLink } = renderStockNews()

    expect(container.querySelectorAll('a.news-item')).toHaveLength(2)
    for (const title of [WRAPPED.title, DIRECT.title]) {
      expect(itemLink(title).querySelector('.news-title')).toBeTruthy()
      expect(itemLink(title).querySelector('.news-meta')?.textContent).toContain(
        title === WRAPPED.title ? WRAPPED.source : DIRECT.source,
      )
    }
  })
})
