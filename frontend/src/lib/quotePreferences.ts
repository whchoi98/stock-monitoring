/**
 * 시세 표 밀도 — 관심 종목과 별개인 브라우저 표시 설정.
 * Quote table density is a browser display preference independent of the watchlist.
 */
import { createLocalStore, useLocalStore } from './localStore.ts'

export type QuoteDensity = 'comfortable' | 'compact'
export const QUOTE_DENSITY_KEY = 'stock-monitoring:quote-density'
export const quoteDensityStore = createLocalStore<QuoteDensity>(
  QUOTE_DENSITY_KEY,
  'comfortable',
  (raw) => raw === 'comfortable' || raw === 'compact' ? raw : null,
)

export function useQuoteDensity(): QuoteDensity {
  return useLocalStore(quoteDensityStore)
}
