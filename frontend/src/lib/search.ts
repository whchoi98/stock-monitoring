/**
 * 종목 검색 — 시세 유니버스(US 50 + KR 50)를 심볼·종목명으로 걸러 순위를 매기는 순수 함수.
 * Symbol search: a pure function that filters and ranks the quote universe (US 50 + KR 50) by symbol and name.
 *
 * 순위: 심볼 정확 일치 > 심볼 접두 > 종목명 접두 > 종목명·심볼 포함. 같은 순위 안에서는 심볼 사전순.
 * KR 코드는 `.KS`/`.KQ` 접미사를 뗀 형태로도 맞춘다 — 사용자는 "005930"을 치고 "005930.KS"를 기대한다.
 * Rank: exact symbol > symbol prefix > name prefix > name or symbol substring; ties break by symbol. KR codes also
 * match without their `.KS`/`.KQ` suffix — a user types "005930" and expects "005930.KS".
 */
import type { Quote } from '../api/types.ts'

/** 기본 결과 상한 — 드롭다운 한 화면 / The default cap: one dropdown's worth */
export const SEARCH_LIMIT = 8

const KR_SUFFIX = /\.(ks|kq)$/

/** 순위 점수 — 낮을수록 앞 / The rank score; lower comes first */
function score(quote: Quote, query: string): number | null {
  const symbol = quote.symbol.toLowerCase()
  const bare = symbol.replace(KR_SUFFIX, '')
  const name = quote.name.toLowerCase()
  if (symbol === query || bare === query) return 0
  if (symbol.startsWith(query) || bare.startsWith(query)) return 1
  if (name.startsWith(query)) return 2
  if (name.includes(query) || symbol.includes(query)) return 3
  return null
}

export function searchSymbols(quotes: Quote[], rawQuery: string, limit = SEARCH_LIMIT): Quote[] {
  const query = rawQuery.trim().toLowerCase()
  if (query === '') return []

  const ranked: { quote: Quote; rank: number }[] = []
  for (const quote of quotes) {
    const rank = score(quote, query)
    if (rank !== null) ranked.push({ quote, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.quote.symbol.localeCompare(b.quote.symbol))
  return ranked.slice(0, limit).map((entry) => entry.quote)
}
