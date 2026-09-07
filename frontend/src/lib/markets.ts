/**
 * 시장 라벨과 시세 스코프 — 컴포넌트 파일 밖에 둔다 (oxlint `react/only-export-components` — 컴포넌트 파일이 상수를 함께
 * export하면 HMR이 깨진다).
 * Market labels and the quote scope, kept outside component files (oxlint `react/only-export-components`: a component
 * file that also exports a constant breaks fast refresh).
 */
import type { Market } from '../api/types.ts'

export const MARKET_LABEL: Record<Market, string> = { us: '미국', kr: '한국' }

/**
 * 시세 목록의 범위 — 한 시장, 또는 사용자의 관심 종목(★, 두 시장 혼합).
 * The scope of a quote list: one market, or the user's watchlist (★, both markets mixed).
 */
export type QuoteScope = Market | 'watch'

export const SCOPE_LABEL: Record<QuoteScope, string> = { us: '미국', kr: '한국', watch: '관심' }

/** 스코프의 시장 — 관심 스코프는 시장이 없으므로 `fallback`(마지막 시장) / The scope's market; the watch scope has none, so `fallback` (the last market) */
export function marketOfScope(scope: QuoteScope, fallback: Market): Market {
  return scope === 'watch' ? fallback : scope
}
