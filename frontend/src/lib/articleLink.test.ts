/**
 * articleLink 테스트 — 분석 가능 판정과 분석 화면 링크의 계약을 고정한다.
 * articleLink tests; they pin the analyzable verdict and the analysis-screen link contract.
 */
import { describe, expect, it } from 'vitest'

import type { NewsItem } from '../api/types.ts'
import { articleHref, isAnalyzable } from './articleLink.ts'

const item = (over: Partial<NewsItem>): NewsItem => ({
  id: 'x',
  title: '제목',
  link: 'https://example.com/a',
  source: 'Yahoo',
  published: '',
  language: 'en',
  ...over,
})

describe('isAnalyzable', () => {
  it('직접 기사 URL은 분석 가능 / a direct article URL is analyzable', () => {
    expect(isAnalyzable(item({ link: 'https://finance.yahoo.com/news/x.html' }))).toBe(true)
  })

  it('Google News 래퍼는 분석 불가 / a Google News wrapper is not analyzable', () => {
    expect(isAnalyzable(item({ link: 'https://news.google.com/rss/articles/CBMiabc?oc=5' }))).toBe(
      false,
    )
  })

  it('news.google.com 하위 도메인/경로 변형도 불가 / other news.google.com shapes are excluded too', () => {
    expect(isAnalyzable(item({ link: 'https://news.google.com/articles/abc' }))).toBe(false)
  })

  it('잘못된 URL은 분석 불가 (throw 금지) / a malformed URL is not analyzable and does not throw', () => {
    expect(isAnalyzable(item({ link: 'not a url' }))).toBe(false)
  })

  /*
   * 빈 링크는 "분석 화면으로" 쪽이다 — 새 탭 분기로 보내면 `<a href="">`가 되어 현재 페이지를 한 번 더
   * 여는 것이 전부다. 백엔드는 `<link>` 없는 RSS 항목을 빈 문자열로 통과시키므로(제목 없는 항목만
   * 버린다) 실제로 도달하는 입력이다.
   * An empty link belongs on the analysis-screen side: sent to the new-tab branch it becomes `<a href="">`,
   * which does nothing but open the current page again. The backend lets an RSS item with no `<link>` through
   * as an empty string (only a missing title drops an item), so this input really arrives.
   */
  it('빈 링크는 분석 화면 쪽으로 보낸다 / an empty link routes to the analysis screen', () => {
    expect(isAnalyzable(item({ link: '' }))).toBe(true)
  })
})

describe('articleHref', () => {
  it('url·title·language를 쿼리로 싣는다 / carries url, title and language as query params', () => {
    const href = articleHref(item({ link: 'https://x.com/a', title: 'T', language: 'ko' }))
    const q = new URL(href, 'http://h').searchParams
    expect([q.get('url'), q.get('title'), q.get('language')]).toEqual([
      'https://x.com/a',
      'T',
      'ko',
    ])
  })
})
