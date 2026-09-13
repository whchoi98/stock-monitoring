/** 시세 탐색 규칙 — 캐시 순서·한글 검색·결측 정렬 / Quote exploration: source order, Hangul and missing values. */
import { describe, expect, it } from 'vitest'

import type { Quote } from '../api/types.ts'
import { filterQuotes, quoteSectors, sortQuotes, type QuoteSortKey } from './quoteFilter.ts'

function quote(symbol: string, overrides: Partial<Quote> = {}): Quote {
  return {
    symbol,
    name: symbol,
    market: 'us',
    currency: 'USD',
    sector: 'Technology',
    price: 10,
    change: 1,
    change_pct: 1,
    market_cap: 100,
    volume: 10,
    ...overrides,
  }
}

describe('filterQuotes', () => {
  const quotes = [
    quote('A', { name: 'Samsung Bio', name_ko: '삼성바이오', sector: 'Healthcare' }),
    quote('B', { name: 'Samsung Electronics', name_ko: '삼성전자', sector: 'Semiconductor', change_pct: -1 }),
    quote('C', { name: 'Samsung SDI', name_ko: '삼성SDI', sector: 'Semiconductor', change_pct: 0 }),
    quote('D', { name: 'SK Hynix', name_ko: '에스케이하이닉스', sector: 'Semiconductor' }),
  ]

  it('combines Korean initials, sector and movement without modifying source quotes', () => {
    const source = Object.freeze(quotes.map((item) => Object.freeze({ ...item })))
    const result = filterQuotes(source, { query: 'ㅅㅅ', sector: 'Semiconductor', movement: 'down' })

    expect(result.map((item) => item.symbol)).toEqual(['B'])
    expect(result[0]).toBe(source[1])
    expect(source.map((item) => item.symbol)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('keeps source order instead of search ranking, including more than eight matches', () => {
    const source = [
      quote('Z', { name: 'Supplier to Apple' }),
      quote('AAPL', { name: 'Apple' }),
      ...Array.from({ length: 9 }, (_, index) => quote(`X${9 - index}`, { name: 'Apple supplier' })),
    ]
    expect(filterQuotes(source, { query: 'apple' }).map((item) => item.symbol)).toEqual([
      'Z', 'AAPL', 'X9', 'X8', 'X7', 'X6', 'X5', 'X4', 'X3', 'X2', 'X1',
    ])
  })

  it('treats whitespace search as no search and excludes no quotes by default', () => {
    expect(filterQuotes(quotes, { query: ' \t ' })).toEqual(quotes)
    expect(filterQuotes(quotes)).toEqual(quotes)
  })

  it.each([
    ['삼ㅅ', ['A', 'B', 'C']],
    ['SAMsung', ['A', 'B', 'C']],
    ['does not exist', []],
  ])('matches partial composition and case-insensitive names: %s', (query, expected) => {
    expect(filterQuotes(quotes, { query }).map((item) => item.symbol)).toEqual(expected)
  })

  it('matches Korean codes without exchange suffixes', () => {
    expect(filterQuotes([quote('005930.KS')], { query: '005930' }).map((item) => item.symbol)).toEqual(['005930.KS'])
  })

  it.each([
    ['all', ['UP', 'DOWN', 'FLAT', 'UNKNOWN']],
    ['up', ['UP']],
    ['down', ['DOWN']],
    ['flat', ['FLAT']],
  ] as const)('distinguishes %s from missing or zero changes', (movement, expected) => {
    const source = [
      quote('UP', { change_pct: 0.001 }),
      quote('DOWN', { change_pct: -0.001 }),
      quote('FLAT', { change_pct: 0 }),
      quote('UNKNOWN', { change_pct: Number.NaN }),
    ]
    expect(filterQuotes(source, { movement }).map((item) => item.symbol)).toEqual(expected)
  })
})

describe('sortQuotes', () => {
  const numericKeys: QuoteSortKey[] = ['price', 'change', 'change_pct', 'market_cap', 'volume']

  it.each(numericKeys)('sorts %s numerically, with missing values last in both directions', (key) => {
    const source = Object.freeze([
      quote('MISSING', { [key]: null }),
      quote('BIG', { [key]: 100 }),
      quote('SMALL', { [key]: 2 }),
      quote('UNKNOWN', { [key]: Number.NaN }),
      quote('ZERO', { [key]: 0 }),
    ])

    expect(sortQuotes(source, { key, direction: 'desc' }).map((item) => item.symbol)).toEqual([
      'BIG', 'SMALL', 'ZERO', 'MISSING', 'UNKNOWN',
    ])
    expect(sortQuotes(source, { key, direction: 'asc' }).map((item) => item.symbol)).toEqual([
      'ZERO', 'SMALL', 'BIG', 'MISSING', 'UNKNOWN',
    ])
    expect(source.map((item) => item.symbol)).toEqual(['MISSING', 'BIG', 'SMALL', 'UNKNOWN', 'ZERO'])
  })

  it('keeps absent and infinite values last, preserving ties and real negative values', () => {
    const source = [
      quote('ABSENT', { market_cap: undefined }),
      quote('FIRST', { market_cap: 2 }),
      quote('SECOND', { market_cap: 2 }),
      quote('NEGATIVE', { market_cap: -2 }),
      quote('INFINITE', { market_cap: Number.POSITIVE_INFINITY }),
    ]
    expect(sortQuotes(source, { key: 'market_cap', direction: 'asc' }).map((item) => item.symbol)).toEqual([
      'NEGATIVE', 'FIRST', 'SECOND', 'ABSENT', 'INFINITE',
    ])
    expect(sortQuotes(source, { key: 'market_cap', direction: 'desc' }).map((item) => item.symbol)).toEqual([
      'FIRST', 'SECOND', 'NEGATIVE', 'ABSENT', 'INFINITE',
    ])
  })

  it('uses natural, case-insensitive text sorting', () => {
    const source = [quote('A10'), quote('a2'), quote('B1')]
    expect(sortQuotes(source, { key: 'symbol', direction: 'asc' }).map((item) => item.symbol)).toEqual(['a2', 'A10', 'B1'])
    expect(sortQuotes(source, { key: 'symbol', direction: 'desc' }).map((item) => item.symbol)).toEqual(['B1', 'A10', 'a2'])
  })

  it('sorts the displayed Korean name and keeps blank names last in either direction', () => {
    const source = [
      quote('MISSING', { name: '  ', name_ko: '' }),
      quote('B', { name: 'Alpha', name_ko: '나무' }),
      quote('A', { name: 'Zebra', name_ko: '가나' }),
    ]
    expect(sortQuotes(source, { key: 'name', direction: 'asc' }).map((item) => item.symbol)).toEqual(['A', 'B', 'MISSING'])
    expect(sortQuotes(source, { key: 'name', direction: 'desc' }).map((item) => item.symbol)).toEqual(['B', 'A', 'MISSING'])
  })

  it('preserves source order without a sort and does not expose a mutable cache array', () => {
    const source = [quote('B'), quote('A')]
    const result = sortQuotes(source, null)
    result.reverse()
    expect(source.map((item) => item.symbol)).toEqual(['B', 'A'])
  })
})

describe('quoteSectors', () => {
  it('offers all unique nonempty sectors in natural order independently of active filters', () => {
    const source = [
      quote('A', { sector: 'Tech 10' }),
      quote('B', { sector: 'Tech 2' }),
      quote('C', { sector: 'Tech 2' }),
      quote('D', { sector: '' }),
      quote('E', { sector: '  ' }),
    ]
    expect(quoteSectors(source)).toEqual(['Tech 2', 'Tech 10'])
  })
})
