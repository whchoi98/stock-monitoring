/**
 * NewsList 테스트 — 시각 열과 두 링크 분기. 분기 규칙 자체는 NewsFeed/StockNews 테스트가 함께 덮는다.
 * NewsList tests: the time column and the two link branches (the branch rule is also covered by the feed tests).
 */
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import type { NewsItem } from '../../api/types.ts'
import { NewsList } from './NewsList.tsx'

const DIRECT: NewsItem = {
  id: 'direct',
  title: 'Fed holds rates steady',
  link: 'https://finance.yahoo.com/news/fed-holds.html',
  source: 'Yahoo Finance',
  published: '2026-08-03T04:00:00Z',
  language: 'en',
}

const WRAPPED: NewsItem = {
  id: 'wrapped',
  title: '코스피 사상 최고치',
  link: 'https://news.google.com/rss/articles/CBMiQXdyYXBwZWQ?oc=5',
  source: '연합뉴스',
  published: 'not-a-date',
  language: 'ko',
}

function renderList(items: NewsItem[]) {
  const view = render(
    <MemoryRouter>
      <NewsList items={items} />
    </MemoryRouter>,
  )
  const row = (title: string) =>
    Array.from(view.container.querySelectorAll<HTMLAnchorElement>('a.news-item')).find(
      (a) => a.querySelector('.news-title')?.textContent === title,
    )!
  return { ...view, row }
}

describe('NewsList', () => {
  it('발행 시각을 HH:MM 열로 낸다 / renders the published time as an HH:MM column', () => {
    const { row } = renderList([DIRECT])
    expect(row(DIRECT.title).querySelector('.news-time')?.textContent).toMatch(/^\d{2}:\d{2}$/)
  })

  it('파싱 불가한 시각은 빈 열을 남긴다 (행은 그대로) / an unparseable time leaves the column empty but keeps the row', () => {
    const { row } = renderList([WRAPPED])
    expect(row(WRAPPED.title).querySelector('.news-time')?.textContent).toBe('')
    expect(row(WRAPPED.title).querySelector('.news-meta')?.textContent).toBe('연합뉴스 · 원문 보기')
  })

  it('분석 가능 항목은 앱 안으로, 불가 항목은 새 탭으로 / analyzable items stay in-app, others open a new tab', () => {
    const { row } = renderList([DIRECT, WRAPPED])
    expect(row(DIRECT.title).getAttribute('href')?.startsWith('/articles?')).toBe(true)
    expect(row(DIRECT.title).getAttribute('target')).toBeNull()
    expect(row(WRAPPED.title).getAttribute('href')).toBe(WRAPPED.link)
    expect(row(WRAPPED.title).getAttribute('target')).toBe('_blank')
    expect(row(WRAPPED.title).getAttribute('rel')).toBe('noreferrer')
  })
})
