/**
 * 뉴스 와이어 목록 — 시장 뉴스(`NewsFeed`)와 종목 뉴스(`StockNews`)가 같은 행을 쓴다: 시각 열 · 제목 · 출처.
 * The news-wire list shared by the market feed (`NewsFeed`) and the per-stock feed (`StockNews`): a time column,
 * the title and the source.
 *
 * 항목을 누르면 기사 AI 분석 화면(`/articles?url=&title=&language=`)으로 간다 — 쿼리 파라미터로 실어야
 * 새로고침·공유가 된다. `<Link>`를 쓰므로 실제 `<a href>`가 렌더된다.
 * 단, 본문 추출이 불가능한 링크(Google News 래퍼)는 분석 화면 대신 원문을 새 탭으로 연다 — 판정과 링크는
 * `lib/articleLink.ts`가 소유한다 (2026-08-03 라이브 버그 수정).
 * A click opens the article AI analysis screen; the query parameters are what make a refresh or a shared URL work,
 * and `<Link>` renders a real `<a href>`. Links we cannot extract (Google News wrappers) open the source in a new tab
 * instead; the verdict and the link live in `lib/articleLink.ts` (live-bug fix 2026-08-03).
 */
import { Link } from 'react-router-dom'

import type { NewsItem } from '../../api/types.ts'
import { articleHref, isAnalyzable } from '../../lib/articleLink.ts'
import { formatClock } from '../../lib/clock.ts'
import { formatPublished } from '../../lib/format.ts'

export interface NewsListProps {
  items: NewsItem[]
}

function NewsRow({ item }: { item: NewsItem }) {
  const published = formatPublished(item.published)
  const clock = formatClock(item.published)
  const analyzable = isAnalyzable(item)

  /*
   * 항목 내용은 두 분기가 그대로 공유한다 — 어디로 가든 시각·접근성이 같아야 한다.
   * Both branches share this body verbatim: wherever the click lands, it must look and read the same.
   */
  const body = (
    <>
      {/* 시각 열 — 파싱 불가면 빈 칸을 남겨 열을 맞춘다 / The time column; unparseable leaves the cell empty to keep alignment */}
      <span className="news-time">{clock ?? ''}</span>
      <span className="news-body">
        <span className="news-title">{item.title}</span>
        <span className="news-meta">
          {item.source}
          {published !== null && ` · ${published}`}
          {/* 분석 화면이 아니라 외부로 나간다는 표식 / The marker for leaving the app instead of analysing */}
          {!analyzable && ' · 원문 보기'}
        </span>
      </span>
    </>
  )

  return analyzable ? (
    <Link className="news-item" to={articleHref(item)}>
      {body}
    </Link>
  ) : (
    /* 원문은 외부 사이트다 — 새 탭으로 열고 rel로 레퍼러/opener를 끊는다 / Off-site: a new tab, with the referrer and opener cut by rel */
    <a className="news-item" href={item.link} target="_blank" rel="noreferrer">
      {body}
    </a>
  )
}

export function NewsList({ items }: NewsListProps) {
  return (
    <ul className="news-list">
      {items.map((item) => (
        <li key={item.id}>
          <NewsRow item={item} />
        </li>
      ))}
    </ul>
  )
}
