/**
 * 시세 필터·정렬 — 서버 시세는 건드리지 않고 화면에 보일 행을 고른다.
 * Quote filtering and sorting derive visible rows without mutating the query cache.
 */
import type { Quote } from '../api/types.ts'
import { searchSymbols } from './search.ts'

export type QuoteMovement = 'all' | 'up' | 'down' | 'flat'
export type QuoteSortKey = 'symbol' | 'name' | 'price' | 'change' | 'change_pct' | 'market_cap' | 'volume'

export interface QuoteSort {
  key: QuoteSortKey
  direction: 'asc' | 'desc'
}

export interface QuoteFilters {
  query?: string
  sector?: string
  movement?: QuoteMovement
}

const textOrder = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })

export function filterQuotes(
  quotes: readonly Quote[],
  { query = '', sector = '', movement = 'all' }: QuoteFilters = {},
): Quote[] {
  // 검색 순위·드롭다운 상한은 표에 적용하지 않는다 / Use every search match, retaining the table's source order.
  const matches = query.trim() === '' ? null : new Set(searchSymbols([...quotes], query, quotes.length))
  return quotes.filter((quote) => {
    if (matches !== null && !matches.has(quote)) return false
    if (sector !== '' && quote.sector !== sector) return false
    if (movement === 'all') return true
    if (!Number.isFinite(quote.change_pct)) return false
    if (movement === 'up') return quote.change_pct > 0
    if (movement === 'down') return quote.change_pct < 0
    return quote.change_pct === 0
  })
}

function sortValue(quote: Quote, key: QuoteSortKey): string | number | null {
  return key === 'name' ? quote.name_ko?.trim() || quote.name : quote[key]
}

function missing(value: string | number | null): boolean {
  return value == null || (typeof value === 'number' ? !Number.isFinite(value) : value.trim() === '')
}

export function sortQuotes(quotes: readonly Quote[], sort: QuoteSort | null): Quote[] {
  const rows = [...quotes]
  if (sort === null) return rows

  return rows.sort((a, b) => {
    const left = sortValue(a, sort.key)
    const right = sortValue(b, sort.key)
    const leftMissing = missing(left)
    const rightMissing = missing(right)
    // 결측 위치는 방향과 무관하다 / Missing values stay last before direction is applied.
    if (leftMissing || rightMissing) return Number(leftMissing) - Number(rightMissing)
    const comparison = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : textOrder.compare(String(left), String(right))
    return sort.direction === 'asc' ? comparison : -comparison
  })
}

export function quoteSectors(quotes: readonly Quote[]): string[] {
  return [...new Set(quotes.map((quote) => quote.sector).filter((sector) => sector.trim() !== ''))]
    .sort(textOrder.compare)
}
