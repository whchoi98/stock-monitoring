/**
 * 종목 검색 — 시세 유니버스(US 50 + KR 50)를 심볼·영문 종목명·한글 종목명(음절·초성·혼합)으로 걸러 순위를 매기는 순수 함수.
 * Symbol search: a pure function that filters and ranks the quote universe (US 50 + KR 50) by symbol, Latin name and
 * Korean name (syllables, initials, or the mixed forms an IME emits).
 *
 * 순위: 심볼 정확 일치 > 심볼 접두 > 종목명(영문 또는 한글) 접두 > 종목명·심볼 포함. 같은 순위 안에서는 심볼 사전순.
 * KR 코드는 `.KS`/`.KQ` 접미사를 뗀 형태로도 맞춘다 — 사용자는 "005930"을 치고 "005930.KS"를 기대한다.
 * 한글은 `lib/hangul.ts`의 `matchHangul`이 맞춘다: 초성만("ㅅㅅㅈㅈ"), 음절("삼성"), IME 조합 중의 혼합("삼ㅅ") 모두,
 * 공백은 양쪽에서 무시한다("메타 플랫폼스" ↔ "ㅁㅌㅍㄹㅍㅅ").
 * Rank: exact symbol > symbol prefix > name prefix (Latin or Korean) > name or symbol substring; ties break by symbol. KR
 * codes also match without their `.KS`/`.KQ` suffix. Korean is matched by `matchHangul` in `lib/hangul.ts`: initials only,
 * syllables, or the mixed mid-composition forms, with spaces ignored on both sides.
 */
import type { Quote } from '../api/types.ts'
import { matchHangul } from './hangul.ts'

/** 기본 결과 상한 — 드롭다운 한 화면 / The default cap: one dropdown's worth */
export const SEARCH_LIMIT = 8

const KR_SUFFIX = /\.(ks|kq)$/

/** 순위 점수 — 낮을수록 앞 / The rank score; lower comes first */
function score(quote: Quote, query: string): number | null {
  const symbol = quote.symbol.toLowerCase()
  const bare = symbol.replace(KR_SUFFIX, '')
  const name = quote.name.toLowerCase()
  const nameKo = quote.name_ko ?? ''
  const hangul = nameKo === '' ? null : matchHangul(nameKo.toLowerCase(), query)
  if (symbol === query || bare === query) return 0
  if (symbol.startsWith(query) || bare.startsWith(query)) return 1
  if (name.startsWith(query) || hangul === 'prefix') return 2
  if (name.includes(query) || hangul === 'includes' || symbol.includes(query)) return 3
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
