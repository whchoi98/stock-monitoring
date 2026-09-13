/**
 * 실제 캐시·관심 스토어로 양 시장 폴링과 부분 실패를 재현한다. fetch 경계만 대체한다.
 * Reproduce polling and partial failures with the real cache and watchlist store; only fetch is stubbed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api/client.ts'
import { QUOTE_POLL_MS, useQuotes, useSymbolUniverse } from '../api/queries.ts'
import type { Envelope, Market, Quote } from '../api/types.ts'
import type { QuoteScope } from './markets.ts'
import { useScopedQuotes } from './scopedQuotes.ts'
import { watchlistStore } from './watchlistStore.ts'

const AAPL: Quote = {
  symbol: 'AAPL',
  name: 'Apple',
  name_ko: '애플',
  price: 245.5,
  change: 2.1,
  change_pct: 0.86,
  volume: 41_234_567,
  market: 'us',
  currency: 'USD',
  sector: 'Technology',
  market_cap: 3_700_000_000_000,
}
const SAMSUNG: Quote = {
  ...AAPL,
  symbol: '005930.KS',
  name: 'Samsung Electronics',
  name_ko: '삼성전자',
  price: 70_000,
  market: 'kr',
  currency: 'KRW',
}

function envelope(data: Quote[], asOf: string): Envelope<Quote[]> {
  return { data, asOf, marketOpen: true }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function marketOf(path: RequestInfo | URL): Market {
  return new URL(String(path), 'http://localhost').searchParams.get('market') as Market
}

const clients: QueryClient[] = []

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: Infinity } },
  })
  clients.push(client)
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return { client, wrapper: Wrapper }
}

async function advance(ms = 1) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  vi.useFakeTimers()
  watchlistStore.set([])
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  watchlistStore.set([])
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('watch polling', () => {
  it('공유 관찰자들이 양 시장을 반복 갱신하며 중복 요청하지 않는다 / repeatedly refreshes both markets through shared, deduplicated queries', async () => {
    watchlistStore.set(['005930.KS', 'AAPL'])
    const versions: Record<Market, Envelope<Quote[]>[]> = {
      us: [
        envelope([AAPL], '2026-09-13T00:00:00Z'),
        envelope([{ ...AAPL, price: 246 }], '2026-09-13T00:00:45Z'),
        envelope([{ ...AAPL, price: 247 }], '2026-09-13T00:01:30Z'),
      ],
      kr: [
        envelope([SAMSUNG], '2026-09-13T00:00:00Z'),
        envelope([{ ...SAMSUNG, price: 70_100 }], '2026-09-13T00:00:45Z'),
        envelope([{ ...SAMSUNG, price: 70_200 }], '2026-09-13T00:01:30Z'),
      ],
    }
    const requests = { us: 0, kr: 0 }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((path) => {
      const market = marketOf(path)
      const next = versions[market][requests[market]++]
      return Promise.resolve(response(next))
    }))
    const { client, wrapper } = setup()
    const { result } = renderHook(() => ({
      watch: useScopedQuotes('watch'),
      rail: useScopedQuotes('watch'),
      market: useQuotes('us'),
      search: useSymbolUniverse(true),
    }), { wrapper })
    await advance()
    expect(result.current.watch.quotes?.map((quote) => quote.price)).toEqual([70_000, 245.5])
    expect(requests).toEqual({ us: 1, kr: 1 })

    await advance(QUOTE_POLL_MS)
    expect(result.current.watch.quotes?.map((quote) => quote.price)).toEqual([70_100, 246])
    expect(requests).toEqual({ us: 2, kr: 2 })

    await advance(QUOTE_POLL_MS)
    expect(result.current.watch.quotes?.map((quote) => quote.price)).toEqual([70_200, 247])
    expect(result.current.rail.quotes).toEqual(result.current.watch.quotes)
    expect(result.current.market.data?.[0].price).toBe(247)
    expect(result.current.search.quotes.map((quote) => quote.price)).toEqual([247, 70_200])
    expect(result.current.watch.asOf).toBe('2026-09-13T00:01:30Z')
    expect(requests).toEqual({ us: 3, kr: 3 })
    expect(client.getQueryCache().getAll().map((query) => query.queryKey).sort()).toEqual([
      ['quotes', 'kr'], ['quotes', 'us'],
    ])
  })

  it('단일 시장에서는 다른 시장의 요청과 폴링을 끈다 / only the selected market fetches and polls outside watch scope', async () => {
    const requests = { us: 0, kr: 0 }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((path) => {
      const market = marketOf(path)
      requests[market]++
      return Promise.resolve(response(envelope([market === 'us' ? AAPL : SAMSUNG], '2026-09-13T00:00:00Z')))
    }))
    const { wrapper } = setup()
    const { rerender } = renderHook((scope: QuoteScope) => useScopedQuotes(scope), {
      wrapper,
      initialProps: 'us' as QuoteScope,
    })
    await advance()
    expect(requests).toEqual({ us: 1, kr: 0 })

    rerender('watch')
    await advance()
    expect(requests).toEqual({ us: 1, kr: 1 })
    await advance(QUOTE_POLL_MS)
    expect(requests).toEqual({ us: 2, kr: 2 })

    rerender('us')
    await advance(QUOTE_POLL_MS)
    expect(requests).toEqual({ us: 3, kr: 2 })
  })
})

describe('partial watch results', () => {
  it.each([
    { available: 'us', quote: AAPL, asOf: '2026-09-13T00:00:30Z' },
    { available: 'kr', quote: SAMSUNG, asOf: '2026-09-13T00:00:00Z' },
  ] as const)('$available 행은 다른 시장 대기 중에도 남는다 / keeps $available rows while the other market is pending', async ({ available, quote, asOf }) => {
    watchlistStore.set(['005930.KS', 'AAPL'])
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((path, init) => {
      if (marketOf(path) === available) return Promise.resolve(response(envelope([quote], asOf)))
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }))
    const { wrapper } = setup()
    const { result } = renderHook(() => useScopedQuotes('watch'), { wrapper })
    await advance()

    expect(result.current.quotes).toEqual([quote])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isFetching).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.asOf).toBe(asOf)
  })

  it.each([
    { available: 'us', quote: AAPL },
    { available: 'kr', quote: SAMSUNG },
  ] as const)('무관한 시장 오류가 $available 관심 행을 지우지 않는다 / an unrelated failure keeps $available watch rows and an explicit error', async ({ available, quote }) => {
    watchlistStore.set([quote.symbol])
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((path) => Promise.resolve(
      marketOf(path) === available
        ? response(envelope([quote], '2026-09-13T00:00:30Z'))
        : response({ detail: 'quotes_unavailable' }, 503),
    )))
    const { wrapper } = setup()
    const { result } = renderHook(() => useScopedQuotes('watch'), { wrapper })
    await advance()

    expect(result.current.quotes).toEqual([quote])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect(result.current.error).toMatchObject({ status: 503, detail: 'quotes_unavailable' })
    expect(result.current.asOf).toBe('2026-09-13T00:00:30Z')
    expect(result.current.retryKeys).toEqual([['quotes', 'us'], ['quotes', 'kr']])
  })

  it('갱신 실패 시장은 기존 행과 시각을 유지한다 / preserves a failed market snapshot while the other market refreshes', async () => {
    watchlistStore.set(['AAPL', '005930.KS'])
    let refresh = false
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((path) => {
      if (marketOf(path) === 'kr') {
        return Promise.resolve(refresh
          ? response({ detail: 'kr_unavailable' }, 503)
          : response(envelope([SAMSUNG], '2026-09-13T00:00:00Z')))
      }
      return Promise.resolve(response(refresh
        ? envelope([{ ...AAPL, price: 246 }], '2026-09-13T00:01:15Z')
        : envelope([AAPL], '2026-09-13T00:00:30Z')))
    }))
    const { client, wrapper } = setup()
    const { result } = renderHook(() => useScopedQuotes('watch'), { wrapper })
    await advance()
    const cached = client.getQueryData<Envelope<Quote[]>>(['quotes', 'kr'])
    expect(result.current.quotes?.map((quote) => quote.price)).toEqual([245.5, 70_000])

    refresh = true
    await advance(QUOTE_POLL_MS)

    expect(result.current.quotes?.map((quote) => quote.price)).toEqual([246, 70_000])
    expect(result.current.quotes?.[1]).toBe(cached?.data[0])
    expect(client.getQueryData(['quotes', 'kr'])).toBe(cached)
    expect(result.current.asOf).toBe('2026-09-13T00:00:00Z')
    expect(result.current.error).toMatchObject({ status: 503, detail: 'kr_unavailable' })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isFetching).toBe(false)
  })
})

describe('watch freshness', () => {
  it.each([
    { symbols: ['AAPL'], us: '2026-09-13T00:00:30Z', kr: '2026-09-12T23:00:00Z', want: '2026-09-13T00:00:30Z' },
    { symbols: ['005930.KS'], us: '2026-09-12T23:00:00Z', kr: '2026-09-13T00:00:30Z', want: '2026-09-13T00:00:30Z' },
    { symbols: ['AAPL', '005930.KS'], us: '2026-09-13T00:00:30Z', kr: '2026-09-13T09:00:00+09:00', want: '2026-09-13T09:00:00+09:00' },
    { symbols: ['AAPL', '005930.KS'], us: '2026-09-13T00:00:30Z', kr: 'invalid', want: undefined },
    { symbols: ['NOT-IN-UNIVERSE'], us: '2026-09-13T00:00:30Z', kr: '2026-09-13T00:00:00Z', want: undefined },
    { symbols: [], us: '2026-09-13T00:00:30Z', kr: '2026-09-13T00:00:00Z', want: undefined },
  ])('실제 관심 행의 가장 오래된 시각 / oldest timestamp for available watched rows: $symbols, $kr', async ({ symbols, us, kr, want }) => {
    watchlistStore.set(symbols)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((path) => Promise.resolve(response(
      marketOf(path) === 'us' ? envelope([AAPL], us) : envelope([SAMSUNG], kr),
    ))))
    const { wrapper } = setup()
    const { result } = renderHook(() => useScopedQuotes('watch'), { wrapper })
    await advance()

    expect(result.current.asOf).toBe(want)
  })
})
