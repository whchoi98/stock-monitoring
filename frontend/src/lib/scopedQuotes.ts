/**
 * 스코프별 시세 — 한 시장의 시세(`useQuotes`) 또는 관심 종목(두 시장 유니버스에서 ★만, 저장 순서). 시세 표와 워치리스트
 * 레일이 같은 훅을 쓴다.
 * Quotes by scope: one market's quotes (`useQuotes`) or the watchlist (the starred symbols out of both markets'
 * universe, in stored order). The quote monitor and the watchlist rail share this hook.
 *
 * 관심 스코프는 양 시장을 폴링하되 `['quotes', market]` 캐시와 진행 중 요청을 공유한다.
 * The watch scope polls both markets through the shared `['quotes', market]` caches and in-flight requests.
 */
import { useMemo } from 'react'

import { useQuotes, useSymbolUniverse } from '../api/queries.ts'
import type { Market, Quote } from '../api/types.ts'
import type { QuoteScope } from './markets.ts'
import { useWatchlist } from './watchlistStore.ts'

export interface ScopedQuotes {
  /** 확보한 관심 행은 다른 시장 로딩·실패 중에도 유지 / Available rows survive another market's loading or failure */
  quotes: Quote[] | undefined
  /** 실제 표시 행이 속한 시장 중 가장 오래된 시각 / Oldest timestamp among markets contributing visible rows */
  asOf: string | undefined
  isLoading: boolean
  isFetching?: boolean
  error: Error | null
  /** 재시도가 무효화할 쿼리 키들 / The query keys a retry invalidates */
  retryKeys: readonly (readonly unknown[])[]
}

export function useScopedQuotes(scope: QuoteScope): ScopedQuotes {
  // 미국은 아래 시장 훅이 폴링한다. 관심일 때 한국도 같은 공유 키로 폴링하며 검색 훅은 수동 관찰자로 남는다.
  // The market hook below polls US in watch scope; this gated KR observer supplies the other poll on its shared key.
  const kr = useQuotes('kr', { enabled: scope === 'watch' })
  // 관심 스코프에서도 훅 수는 같아야 한다 — 시장 훅은 미국 키를 관찰한다 (유니버스가 같은 키를 쓰므로 추가 요청은 없다)
  // The hook count must not change with the scope; the market hook observes the US key (the universe shares it, so no extra request)
  const market: Market = scope === 'watch' ? 'us' : scope
  const single = useQuotes(market)
  const universe = useSymbolUniverse(scope === 'watch')
  const { symbols } = useWatchlist()

  return useMemo(() => {
    if (scope !== 'watch') {
      return {
        quotes: single.data,
        asOf: single.asOf,
        isLoading: single.isLoading,
        isFetching: single.isFetching,
        error: single.error,
        retryKeys: [['quotes', scope]],
      }
    }
    const bySymbol = new Map(universe.quotes.map((quote) => [quote.symbol, quote]))
    const quotes = symbols.flatMap((symbol) => {
      const quote = bySymbol.get(symbol)
      return quote === undefined ? [] : [quote]
    })
    const isLoading = symbols.length > 0 && quotes.length === 0
      && (universe.isLoading || single.isLoading || kr.isLoading)
    return {
      quotes: isLoading ? undefined : quotes,
      asOf: watchAsOf(quotes, { us: single.asOf, kr: kr.asOf }),
      isLoading,
      isFetching: Boolean(single.isFetching || kr.isFetching || universe.isFetching),
      error: universe.error,
      retryKeys: [['quotes', 'us'], ['quotes', 'kr']],
    }
  }, [
    scope, single.data, single.asOf, single.isLoading, single.isFetching, single.error,
    kr.asOf, kr.isLoading, kr.isFetching,
    universe.quotes, universe.isLoading, universe.isFetching, universe.error, symbols,
  ])
}

/** 관심 행이 없는 시장의 시각은 제외한다 / Exclude timestamps from markets without watched rows */
function watchAsOf(quotes: Quote[], timestamps: Record<Market, string | undefined>): string | undefined {
  let oldest: string | undefined
  for (const market of new Set(quotes.map((quote) => quote.market))) {
    const timestamp = timestamps[market]
    if (timestamp === undefined || !Number.isFinite(Date.parse(timestamp))) return undefined
    if (oldest === undefined || Date.parse(timestamp) < Date.parse(oldest)) oldest = timestamp
  }
  return oldest
}
