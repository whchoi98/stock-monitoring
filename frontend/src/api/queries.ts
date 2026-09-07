/**
 * TanStack Query 훅 — envelope을 언래핑해 화면이 쓰는 평평한 형태로 돌려준다.
 * TanStack Query hooks; they unwrap the envelope into the flat shape the UI consumes.
 *
 * 모든 훅은 `{data, asOf, marketOpen, isLoading, error}`를 돌려준다.
 * 폴링은 여기 정의된 두 상수만 쓴다 — 수동 setInterval 금지.
 * Every hook returns `{data, asOf, marketOpen, isLoading, error}`, and polling uses only the two constants
 * defined here; never a hand-rolled setInterval.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { apiGet } from './client.ts'
import type {
  ChartData,
  Envelope,
  InvestorsData,
  Market,
  NewsItem,
  OrderBookData,
  Overview,
  Period,
  Quote,
  StockDetail,
} from './types.ts'

/** 시세류 폴링 주기 / Polling interval for price-like data */
export const QUOTE_POLL_MS = 45_000

/** 뉴스 폴링 주기 / Polling interval for news */
export const NEWS_POLL_MS = 120_000

/**
 * 모든 쿼리 훅의 반환 형태 / The shape every query hook returns.
 *
 * 첫 로딩 중이거나 실패했으면 세 값 모두 undefined다 — `marketOpen`을 false로 꾸미지 않는다
 * (모르는 것과 장이 닫힌 것은 다르다).
 * All three are undefined while first loading or after a failure: `marketOpen` is never faked to
 * false, because "unknown" and "closed" are different things.
 */
export interface QueryResult<T> {
  data: T | undefined
  asOf: string | undefined
  marketOpen: boolean | undefined
  isLoading: boolean
  error: Error | null
}

/** envelope을 평평하게 펼친다 / Flatten the envelope */
function unwrap<T>(
  envelope: Envelope<T> | undefined,
  isLoading: boolean,
  error: Error | null,
): QueryResult<T> {
  return {
    data: envelope?.data,
    asOf: envelope?.asOf,
    marketOpen: envelope?.marketOpen,
    isLoading,
    error,
  }
}

/** GET + 폴링 + 언래핑 공통 처리 / Shared GET, polling and unwrapping */
function useEnvelopeQuery<T>(
  queryKey: readonly unknown[],
  path: string,
  refetchInterval: number,
): QueryResult<T> {
  const query = useQuery({
    queryKey,
    queryFn: () => apiGet<T>(path),
    refetchInterval,
  })
  return unwrap(query.data, query.isLoading, query.error)
}

// ---------------------------------------------------------------------------
// 시장 / Market
// ---------------------------------------------------------------------------

/** 지수 + 경제지표 + 시장요약 + 섹터 / Indices, indicators, summaries and sectors */
export function useOverview(): QueryResult<Overview> {
  return useEnvelopeQuery(['overview'], '/api/market/overview', QUOTE_POLL_MS)
}

/**
 * 시세 쿼리의 키와 fetch — `useQuotes`와 `useSymbolUniverse`가 공유한다. 키가 같아야 시세 표·워치리스트·
 * 검색이 한 캐시를 읽고, 요청도 한 번만 나간다.
 * The quotes query's key and fetch, shared by `useQuotes` and `useSymbolUniverse`: one key means the table, the
 * watchlist and the search read one cache and one request goes out.
 */
function quotesQuery(market: Market) {
  return {
    queryKey: ['quotes', market] as const,
    queryFn: () => apiGet<Quote[]>(`/api/market/quotes?market=${market}`),
  }
}

/** 한 시장의 시세 테이블 / One market's quote table */
export function useQuotes(market: Market): QueryResult<Quote[]> {
  const query = useQuery({ ...quotesQuery(market), refetchInterval: QUOTE_POLL_MS })
  return unwrap(query.data, query.isLoading, query.error)
}

/** 검색용 종목 유니버스 (US + KR) / The symbol universe for search (US plus KR) */
export interface SymbolUniverse {
  quotes: Quote[]
  isLoading: boolean
}

/**
 * 종목 검색이 쓰는 두 시장의 시세 — `enabled`가 false인 동안에는 요청을 내지 않는다.
 * The two markets' quotes for symbol search; while `enabled` is false no request goes out.
 *
 * 폴링 주기를 주지 않는다 — 검색은 신선한 가격이 필요 없다. 같은 키를 관찰하는 시세 표·워치리스트가 있으면
 * 그쪽의 45초 폴링이 캐시를 갱신하고, 이 훅은 그 값을 그냥 읽는다 (react-query는 관찰자 중 가장 짧은 주기로 돈다).
 * No polling interval here: search needs no fresh prices. When a table or watchlist observes the same key, its 45s
 * poll refreshes the cache and this hook simply reads it (react-query polls at the shortest interval among observers).
 */
export function useSymbolUniverse(enabled: boolean): SymbolUniverse {
  const us = useQuery({ ...quotesQuery('us'), enabled })
  const kr = useQuery({ ...quotesQuery('kr'), enabled })
  const usData = us.data?.data
  const krData = kr.data?.data
  const quotes = useMemo(() => [...(usData ?? []), ...(krData ?? [])], [usData, krData])
  return { quotes, isLoading: us.isLoading || kr.isLoading }
}

/** 전체 뉴스 피드 / The whole news feed */
export function useNews(): QueryResult<NewsItem[]> {
  return useEnvelopeQuery(['news'], '/api/market/news', NEWS_POLL_MS)
}

// ---------------------------------------------------------------------------
// 종목 / Stocks
// ---------------------------------------------------------------------------

/** 종목 상세 / A stock's detail */
export function useStock(symbol: string): QueryResult<StockDetail> {
  return useEnvelopeQuery(['stock', symbol], `/api/stocks/${path(symbol)}`, QUOTE_POLL_MS)
}

/** 종목 차트 (OHLCV + MA + 크로스) / A stock's chart (OHLCV, MAs and crosses) */
export function useChart(symbol: string, period: Period): QueryResult<ChartData> {
  return useEnvelopeQuery(
    ['chart', symbol, period],
    `/api/stocks/${path(symbol)}/chart?period=${period}`,
    QUOTE_POLL_MS,
  )
}

/** 종목 뉴스 / A stock's news */
export function useStockNews(symbol: string): QueryResult<NewsItem[]> {
  return useEnvelopeQuery(['stock-news', symbol], `/api/stocks/${path(symbol)}/news`, NEWS_POLL_MS)
}

/** 호가 (시뮬레이션) / The order book (simulated) */
export function useOrderBook(symbol: string): QueryResult<OrderBookData> {
  return useEnvelopeQuery(
    ['orderbook', symbol],
    `/api/stocks/${path(symbol)}/orderbook`,
    QUOTE_POLL_MS,
  )
}

/** 수급 (시뮬레이션) / Investor flows (simulated) */
export function useInvestors(symbol: string): QueryResult<InvestorsData> {
  return useEnvelopeQuery(
    ['investors', symbol],
    `/api/stocks/${path(symbol)}/investors`,
    QUOTE_POLL_MS,
  )
}

/*
 * AI 분석 훅은 여기 없다 / The AI analysis hooks do not live here.
 *
 * 두 AI 엔드포인트는 SSE(`phase`→`delta`*→`final`)를 흘리므로 `api/aiStream.ts`의 스트리밍 훅
 * (`useStockAIStream`/`useArticleAIStream`)이 담당한다 — react-query는 키마다 완결된 결과 하나를 캐시하는
 * 모델이라 진행 중 텍스트를 담을 자리가 없다. 그 파일이 "서버 상태는 react-query로만" 규칙의 유일한
 * 예외이며, 이 파일은 그 예외를 넓히지 않는다.
 * Both AI endpoints stream SSE (`phase`, deltas, `final`), so `api/aiStream.ts`'s hooks own them: react-query
 * caches one settled result per key and has nowhere to put in-flight text. That file is the single exception to
 * the "server state lives in react-query" rule, and this file does not widen it.
 */

/** 심볼을 경로 세그먼트로 / A symbol as a path segment */
function path(symbol: string): string {
  return encodeURIComponent(symbol)
}
