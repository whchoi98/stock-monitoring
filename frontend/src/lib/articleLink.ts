/**
 * 뉴스 링크 유틸 — 분석 가능 판정 + 분석 화면 링크. StockNews·NewsFeed가 공유한다.
 * News-link helpers: the analyzable test and the analysis-screen link, shared by StockNews and NewsFeed.
 *
 * KR 종목뉴스는 Google News 검색 RSS라 링크가 `news.google.com/...` 래퍼다 — 실기사가 아니라
 * Google JS 셸로 리다이렉트되어 본문 추출이 불가능하다 (백엔드가 502 article_unavailable). 그래서
 * 이런 링크는 분석 화면 대신 원문 새 탭으로 연다 (2026-08-03 라이브 버그 수정).
 * KR per-symbol news comes from Google News search RSS, so its links are `news.google.com/...` wrappers
 * that redirect to a Google JS shell rather than the real article — extraction cannot work (the backend
 * returns 502 article_unavailable). Such links open the source in a new tab instead of the analysis
 * screen (live-bug fix 2026-08-03).
 */
import type { NewsItem } from '../api/types.ts'

/** 본문 추출이 불가능한 호스트 / Hosts whose links cannot be extracted */
const UNANALYZABLE_HOSTS = new Set(['news.google.com'])

/** 원문 URL을 직접 얻을 수 있어 분석 가능한지 / Whether the item's link is a real article we can extract */
export function isAnalyzable(item: NewsItem): boolean {
  try {
    return !UNANALYZABLE_HOSTS.has(new URL(item.link).hostname)
  } catch {
    return false // URL 파싱 실패 = 분석 대상 아님 / an unparseable URL is not analyzable
  }
}

/**
 * 기사 분석 화면 링크 / The link to the article analysis screen.
 *
 * 쿼리 파라미터 이름은 `/articles`(`pages/ArticleAnalysis.tsx`)와의 계약이다 — 새로고침·공유가
 * 되는 것도 이 파라미터 덕이다 (스펙 6.2 ③).
 * The parameter names are a contract with `/articles` (`pages/ArticleAnalysis.tsx`); they are also what
 * makes a refresh or a shared URL work (spec 6.2 ③).
 */
export function articleHref(item: NewsItem): string {
  const params = new URLSearchParams({
    url: item.link,
    title: item.title,
    language: item.language,
  })
  return `/articles?${params.toString()}`
}
