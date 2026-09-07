/** 뉴스 필터 테스트 / News filter tests */
import { describe, expect, it } from 'vitest'

import type { NewsItem } from '../api/types.ts'
import { filterNews } from './newsFilter.ts'

function item(id: string, title: string, language: NewsItem['language']): NewsItem {
  return { id, title, link: `https://example.com/${id}`, source: 's', published: '2026-09-07T00:00:00Z', language }
}

const ITEMS = [
  item('a', 'Fed holds rates steady', 'en'),
  item('b', '코스피 사상 최고치', 'ko'),
  item('c', 'Samsung beats estimates', 'en'),
]

describe('filterNews', () => {
  it('전체 + 빈 질의는 그대로 / all with an empty query passes everything', () => {
    expect(filterNews(ITEMS, { language: 'all', query: '' })).toEqual(ITEMS)
    expect(filterNews(ITEMS, { language: 'all', query: '   ' })).toEqual(ITEMS)
  })

  it('언어로 거른다 / filters by language', () => {
    expect(filterNews(ITEMS, { language: 'ko', query: '' }).map((i) => i.id)).toEqual(['b'])
    expect(filterNews(ITEMS, { language: 'en', query: '' }).map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('제목 키워드는 대소문자를 가리지 않는다 / the title keyword is case-insensitive', () => {
    expect(filterNews(ITEMS, { language: 'all', query: 'SAMSUNG' }).map((i) => i.id)).toEqual(['c'])
    expect(filterNews(ITEMS, { language: 'all', query: '코스피' }).map((i) => i.id)).toEqual(['b'])
  })

  it('언어와 키워드를 함께 적용한다 / language and keyword combine', () => {
    expect(filterNews(ITEMS, { language: 'en', query: 'rates' }).map((i) => i.id)).toEqual(['a'])
    expect(filterNews(ITEMS, { language: 'ko', query: 'rates' })).toEqual([])
  })
})
