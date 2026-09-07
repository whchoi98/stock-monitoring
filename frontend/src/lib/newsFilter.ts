/**
 * 뉴스 와이어 필터 — 언어 탭(전체 / 한국어 / English)과 제목 키워드. 순수 함수.
 * The news-wire filter: a language tab (all / Korean / English) and a title keyword. Pure.
 */
import type { Language, NewsItem } from '../api/types.ts'

export type NewsLanguageFilter = 'all' | Language

export interface NewsFilter {
  language: NewsLanguageFilter
  /** 제목 포함 검색 — 대소문자 무시, 앞뒤 공백 무시 / Title substring, case-insensitive, trimmed */
  query: string
}

export const NEWS_LANGUAGE_LABEL: Record<NewsLanguageFilter, string> = {
  all: '전체',
  ko: '한국어',
  en: 'English',
}

export function filterNews(items: readonly NewsItem[], filter: NewsFilter): NewsItem[] {
  const query = filter.query.trim().toLowerCase()
  return items.filter((item) => {
    if (filter.language !== 'all' && item.language !== filter.language) return false
    if (query !== '' && !item.title.toLowerCase().includes(query)) return false
    return true
  })
}
