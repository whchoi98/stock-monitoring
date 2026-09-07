/**
 * 스코프별 시세 — 한 시장의 시세(`useQuotes`) 또는 관심 종목(두 시장 유니버스에서 ★만, 저장 순서). 시세 표와 워치리스트
 * 레일이 같은 훅을 쓴다.
 * Quotes by scope: one market's quotes (`useQuotes`) or the watchlist (the starred symbols out of both markets'
 * universe, in stored order). The quote monitor and the watchlist rail share this hook.
 *
 * 관심 스코프도 `['quotes', market]` 키를 읽으므로 새 요청은 없다 — 유니버스는 `enabled`로 관심 스코프일 때만 켠다.
 * The watch scope reads the same `['quotes', market]` keys, so nothing new is requested; the universe is enabled only in
 * that scope.
 */
import { useMemo } from 'react'

import { useQuotes, useSymbolUniverse } from '../api/queries.ts'
import type { Market, Quote } from '../api/types.ts'
import type { QuoteScope } from './markets.ts'
import { useWatchlist } from './watchlistStore.ts'

export interface ScopedQuotes {
  /** 로딩·실패 중엔 undefined / undefined while loading or after a failure */
  quotes: Quote[] | undefined
  /** 관심 스코프는 두 응답을 섞으므로 기준 시각이 없다 / The watch scope mixes two responses and so has no single as-of */
  asOf: string | undefined
  isLoading: boolean
  error: Error | null
  /** 재시도가 무효화할 쿼리 키들 / The query keys a retry invalidates */
  retryKeys: readonly (readonly unknown[])[]
}

export function useScopedQuotes(scope: QuoteScope): ScopedQuotes {
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
        error: single.error,
        retryKeys: [['quotes', scope]],
      }
    }
    const bySymbol = new Map(universe.quotes.map((quote) => [quote.symbol, quote]))
    const quotes = symbols.flatMap((symbol) => {
      const quote = bySymbol.get(symbol)
      return quote === undefined ? [] : [quote]
    })
    return {
      quotes: universe.isLoading ? undefined : quotes,
      asOf: undefined,
      isLoading: universe.isLoading,
      error: universe.error,
      retryKeys: [['quotes', 'us'], ['quotes', 'kr']],
    }
  }, [scope, single.data, single.asOf, single.isLoading, single.error, universe.quotes, universe.isLoading, universe.error, symbols])
}
