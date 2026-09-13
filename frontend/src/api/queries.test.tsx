/**
 * 실제 QueryClient와 GET 경계를 검증한다 — 쿼리 훅·캐시·취소는 mock하지 않는다.
 * Exercise the real QueryClient and GET boundary; hooks, caching and cancellation are not mocked.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from './client.ts'
import { useOverview, useQuotes, useSymbolUniverse } from './queries.ts'
import type { Envelope, Quote } from './types.ts'

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
const SNAPSHOT: Envelope<Quote[]> = {
  data: [AAPL],
  asOf: '2026-09-13T00:00:00Z',
  marketOpen: true,
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

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

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
}

const clients: QueryClient[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('query cancellation', () => {
  it.each([
    { label: 'quotes', useHook: () => useQuotes('us') },
    { label: 'overview', useHook: () => useOverview() },
    { label: 'universe', useHook: () => useSymbolUniverse(true) },
  ])('$label 관찰 해제가 fetch를 취소한다 / unmount aborts $label fetches', async ({ useHook }) => {
    const signals: (AbortSignal | null | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((_path, init) => {
      const signal = init?.signal
      signals.push(signal)
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    const { wrapper } = setup()
    const view = renderHook(() => useHook(), { wrapper })
    await flush()
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true)

    view.unmount()

    expect(signals.every((signal) => signal?.aborted === true)).toBe(true)
    await flush()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('quote query snapshots', () => {
  it('실패한 갱신은 마지막 스냅샷과 오류를 함께 노출한다 / exposes the last snapshot alongside a failed refresh', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(SNAPSHOT))
    vi.stubGlobal('fetch', fetchMock)
    const { client, wrapper } = setup()
    const { result } = renderHook(() => useQuotes('us'), { wrapper })
    await flush()
    const previous = result.current.data
    expect(previous).toEqual([AAPL])
    expect(result.current.isFetching).toBe(false)

    let failRefresh!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { failRefresh = resolve }))
    let refresh!: Promise<void>
    act(() => { refresh = client.invalidateQueries({ queryKey: ['quotes', 'us'] }) })
    await flush()
    expect(result.current.isFetching).toBe(true)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.data).toBe(previous)

    await act(async () => {
      failRefresh(jsonResponse({ detail: 'quotes_unavailable' }, 503))
      await refresh
    })
    await flush()

    expect(result.current.error).toBeInstanceOf(ApiError)
    expect(result.current.error).toMatchObject({ status: 503, detail: 'quotes_unavailable' })
    expect(result.current.data).toBe(previous)
    expect(result.current.asOf).toBe('2026-09-13T00:00:00Z')
    expect(result.current.marketOpen).toBe(true)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isFetching).toBe(false)
    expect(client.getQueryData(['quotes', 'us'])).toEqual(SNAPSHOT)
  })

  it('갱신 제한시간이 지나도 마지막 데이터를 보존한다 / a timed-out refresh retains the last data', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(SNAPSHOT))
      .mockImplementation((_path, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { client, wrapper } = setup()
    const { result } = renderHook(() => useQuotes('us'), { wrapper })
    await flush()
    act(() => { void client.invalidateQueries({ queryKey: ['quotes', 'us'] }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })

    expect(result.current.data).toEqual([AAPL])
    expect(result.current.asOf).toBe('2026-09-13T00:00:00Z')
    expect(result.current.error).toMatchObject({ name: 'TimeoutError' })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isFetching).toBe(false)
  })
})

describe('symbol universe', () => {
  it('검색은 활성화 전 요청과 자체 폴링을 하지 않는다 / search stays gated and does not poll on its own', async () => {
    const fetchMock = vi.fn<typeof fetch>((path) => Promise.resolve(jsonResponse({
      ...SNAPSHOT,
      data: String(path).includes('market=kr') ? [SAMSUNG] : [AAPL],
    })))
    vi.stubGlobal('fetch', fetchMock)
    const { wrapper } = setup()
    const { result, rerender } = renderHook((enabled) => useSymbolUniverse(enabled), {
      wrapper,
      initialProps: false,
    })
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()

    rerender(true)
    await flush()
    expect(result.current.quotes.map((quote) => quote.symbol)).toEqual(['AAPL', '005930.KS'])
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('다른 시장이 대기 중이어도 확보한 행은 쓸 수 있다 / available rows are usable while the other market is pending', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((path, init) => {
      if (String(path).includes('market=us')) return Promise.resolve(jsonResponse(SNAPSHOT))
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }))
    const { wrapper } = setup()
    const { result } = renderHook(() => useSymbolUniverse(true), { wrapper })
    await flush()

    expect(result.current.quotes).toEqual([AAPL])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isFetching).toBe(true)
    expect(result.current.error).toBeNull()
  })
})
