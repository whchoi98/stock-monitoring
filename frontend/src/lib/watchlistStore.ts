/**
 * 관심 종목 (MY WATCHLIST) — ★로 고른 심볼 목록. 브라우저(localStorage)에만 저장되며 백엔드는 모른다.
 * The user's watchlist: the symbols starred with ★, stored in the browser (localStorage) only; the backend never sees it.
 *
 * 순서는 추가한 순서다 — 사용자가 고른 차례가 곧 목록의 차례다.
 * Order is insertion order: the sequence the user picked is the sequence of the list.
 */
import { createLocalStore, parseStringArray, useLocalStore } from './localStore.ts'

export const WATCHLIST_KEY = 'stock-monitoring:watchlist'

export const watchlistStore = createLocalStore<string[]>(WATCHLIST_KEY, [], parseStringArray)

/** 심볼을 넣거나 뺀다 / Add or remove a symbol */
export function toggleWatch(symbol: string): void {
  const current = watchlistStore.get()
  watchlistStore.set(
    current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol],
  )
}

export interface Watchlist {
  /** 저장된 심볼, 추가 순 / The stored symbols in insertion order */
  symbols: string[]
  has(symbol: string): boolean
  toggle(symbol: string): void
}

export function useWatchlist(): Watchlist {
  const symbols = useLocalStore(watchlistStore)
  return { symbols, has: (symbol) => symbols.includes(symbol), toggle: toggleWatch }
}
