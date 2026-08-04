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

/**
 * 원문 URL을 직접 얻을 수 있어 분석 가능한지 / Whether the item's link is a real article we can extract.
 *
 * 판정의 실제 쓰임은 "분석 화면(앱 안)으로 보낼지, 원문을 새 탭으로 열지"의 갈림길이다 —
 * `StockNews`·`NewsFeed`가 이 값으로 `<Link>`와 `<a target="_blank">`를 고른다.
 * The verdict is really the fork "send this to the analysis screen (in-app) or open the source in a new tab":
 * `StockNews` and `NewsFeed` pick between `<Link>` and `<a target="_blank">` with it.
 *
 * **빈 링크는 `true`다** — 이름만 보면 어색하지만 두 대안이 모두 더 나쁘다. 백엔드는 `<link>` 없는 RSS
 * 항목을 빈 문자열로 통과시키므로(제목 없는 항목만 버린다 — `app/services/news.py`) 실제로 도달하는
 * 입력이고, `false`로 두면 `<a href="" target="_blank">`가 되어 클릭이 **현재 페이지를 새 탭에 한 번 더
 * 여는** 것으로 끝난다(사용자에게는 아무 일도 안 한 것처럼 보인다). `true`면 `/articles?url=`로 가고,
 * 그 화면이 빈 url을 "잘못된 접근" 카드로 안내한다 (`pages/ArticleAnalysis.tsx` — 훅을 부르기 전에
 * 판정하므로 유료 호출도 나가지 않는다). 즉 빈 링크의 정직한 목적지는 이미 존재하는 그 안내 화면이다.
 * **An empty link is `true`.** The name reads oddly for that case, but both alternatives are worse. The
 * backend passes an RSS item with no `<link>` through as an empty string (only a missing title drops an item —
 * `app/services/news.py`), so the input really arrives, and with `false` it becomes `<a href="" target="_blank">`
 * whose click merely **opens the current page again in a new tab** — indistinguishable from doing nothing.
 * With `true` it goes to `/articles?url=`, where the screen answers an empty url with its "잘못된 접근" card
 * (`pages/ArticleAnalysis.tsx` decides before any hook runs, so no paid call leaves either). The honest
 * destination for an empty link is that already-existing explanation.
 */
export function isAnalyzable(item: NewsItem): boolean {
  if (item.link === '') return true
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
