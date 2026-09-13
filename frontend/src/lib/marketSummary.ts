import type { Quote } from '../api/types.ts'

/** 추적 종목만 집계한다. 시장 전체의 통계로 해석하지 않는다.
 * Breadth describes the observed universe, including unchanged quotes.
 */
export function summarizeQuotes(quotes: readonly Quote[]) {
  const gainers = quotes.filter(quote => quote.change_pct > 0).sort((a, b) => b.change_pct - a.change_pct)
  const losers = quotes.filter(quote => quote.change_pct < 0).sort((a, b) => a.change_pct - b.change_pct)
  const unchanged = quotes.filter(quote => quote.change_pct === 0).length
  return {
    total: quotes.length,
    advancing: gainers.length,
    declining: losers.length,
    unchanged,
    advancingPct: quotes.length === 0 ? null : gainers.length / quotes.length * 100,
    gainers: gainers.slice(0, 3),
    losers: losers.slice(0, 3),
    volume: [...quotes].sort((a, b) => b.volume - a.volume).slice(0, 3),
  }
}
