/**
 * 백엔드 응답 타입 — `backend/app/models.py`의 pydantic 모델과 1:1 대응.
 * Backend response types, mapped 1:1 onto the pydantic models in `backend/app/models.py`.
 *
 * 필드명은 백엔드가 내보내는 그대로(snake_case) 둔다 — 백엔드는 camelCase 변환을 하지 않는다.
 * 유일한 camelCase는 envelope의 `asOf`/`marketOpen`이다.
 * Field names stay exactly as the backend emits them (snake_case); the backend performs no camelCase
 * conversion. The only camelCase keys are the envelope's `asOf`/`marketOpen`.
 */
import type { Currency } from '../lib/format.ts'

/** 시장 코드 — 백엔드는 항상 소문자로 내보낸다 / Market code; the backend always emits lower case */
export type Market = 'us' | 'kr'

/** 차트/기간수익률 기간 / Chart and period-return windows */
export type Period = '1w' | '1m' | '3m' | '1y'

/** 뉴스·AI 요청 언어 / Language of a news item and of an AI request */
export type Language = 'ko' | 'en'

/**
 * 모든 응답의 공통 래퍼 / The wrapper every response carries.
 *
 * `asOf`는 데이터가 만들어진 시각(캐시 시각), `marketOpen`은 응답 시점의 장중 여부다.
 * `asOf` is when the data was produced (its cache timestamp); `marketOpen` is the open flag at response time.
 */
export interface Envelope<T> {
  asOf: string
  marketOpen: boolean
  data: T
}

// ---------------------------------------------------------------------------
// 시세 / Quotes
// ---------------------------------------------------------------------------

/** 개별 주식 시세 / An individual stock quote */
export interface Quote {
  symbol: string
  name: string
  price: number
  change: number
  change_pct: number
  volume: number
  market: Market
  currency: Currency
  sector: string
  /** 시총은 B12 스케줄러가 별도 주기로 채우므로 아직 없을 수 있다 / Filled on a separate cycle, so it can be absent */
  market_cap: number | null
}

/** 시장 지수 / A market index */
export interface IndexQuote {
  symbol: string
  name: string
  value: number
  change: number
  change_pct: number
}

/** 경제 지표 / An economic indicator */
export interface Indicator {
  symbol: string
  name: string
  value: number
  change: number
  change_pct: number
  unit: string
}

// ---------------------------------------------------------------------------
// 뉴스 / News
// ---------------------------------------------------------------------------

/** 뉴스 아이템 / A news item */
export interface NewsItem {
  id: string
  title: string
  link: string
  source: string
  published: string
  language: Language
}

// ---------------------------------------------------------------------------
// 차트 / Chart
// ---------------------------------------------------------------------------

/** 캔들 (OHLCV) / A candle (OHLCV) */
export interface Candle {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** 이동평균 크로스 신호 / A moving-average cross signal */
export interface CrossSignal {
  time: string
  kind: 'golden' | 'dead'
}

/**
 * 차트 응답 / The chart response.
 *
 * `ma5`/`ma20`은 `candles`와 같은 길이이고, 이동평균이 아직 성립하지 않는 앞쪽 구간은 null이다.
 * `ma5`/`ma20` are as long as `candles`; the leading region where the average is not yet defined is null.
 */
export interface ChartData {
  symbol: string
  period: Period
  candles: Candle[]
  ma5: (number | null)[]
  ma20: (number | null)[]
  signals: CrossSignal[]
}

// ---------------------------------------------------------------------------
// 종목 상세 / Stock detail
// ---------------------------------------------------------------------------

/**
 * 종목 상세 (백엔드 `StockDetailResponse`) / Stock detail (the backend's `StockDetailResponse`).
 *
 * **단위 주의 — 두 필드의 스케일이 다르다 / Unit asymmetry, two different scales:**
 * - `returns`의 값과 `change_pct`/`day_change_pct`는 **퍼센트 스케일**이다 (1.5 === +1.5%).
 * - `dividend_yield`는 **원시 분수**다 (0.0044 === 0.44%).
 * 즉 `returns`는 그대로 표시하고, `dividend_yield`만 100을 곱한다 — 이중 변환 금지.
 * So render `returns` as-is and multiply only `dividend_yield` by 100; never convert twice.
 *
 * 가격 계열(`price`/`change`/`change_pct`/`volume`)은 요청 시점에 45초 시세 캐시에서 덮어써진다.
 * `day_change`/`day_change_pct`는 `change`/`change_pct`의 미러 필드다 (TUI 호환).
 * The price-like fields are overlaid at request time from the 45s quote cache, and
 * `day_change`/`day_change_pct` mirror `change`/`change_pct` (TUI compatibility).
 */
export interface StockDetail {
  symbol: string
  name: string
  market: Market
  currency: Currency
  price: number
  change: number
  change_pct: number
  open_price: number
  high: number
  low: number
  prev_close: number
  volume: number
  avg_volume: number
  /**
   * Quote.market_cap과 달리 null이 아니라 결측을 0으로 채운다 (백엔드 `_fast_float`).
   * `formatMarketCap`이 0 이하를 "—"로 처리하므로 그대로 넘기면 된다.
   * Unlike Quote.market_cap this is never null; a miss becomes 0 (the backend's `_fast_float`).
   * `formatMarketCap` renders anything <= 0 as "—", so it can be passed through as-is.
   */
  market_cap: number
  week52_high: number
  week52_low: number
  day_change: number
  day_change_pct: number
  sector: string
  /** 펀더멘털은 yfinance 부분 실패 시 결측 / Fundamentals are absent when yfinance partially fails */
  pe_ratio: number | null
  eps: number | null
  /** 원시 분수 (0.0044 === 0.44%) / Raw fraction (0.0044 === 0.44%) */
  dividend_yield: number | null
  beta: number | null
  pbr: number | null
  /** 기간수익률 (퍼센트 스케일). 이력이 짧으면 값이 null, 조회 실패 시 dict 자체가 null.
   *  Period returns in percent scale; null per key when history is short, null overall on failure. */
  returns: Partial<Record<Period, number | null>> | null
  last_updated: string | null
}

// ---------------------------------------------------------------------------
// 호가 / 수급 (시뮬레이션) / Order book and investor flows (simulated)
// ---------------------------------------------------------------------------

/** 호가 한 줄 / One order book row */
export interface OrderBookEntry {
  price: number
  qty: number
  side: 'bid' | 'ask'
}

/**
 * 호가 응답 / The order book response.
 *
 * `entries`는 매도 10 + 매수 10을 기대하지만 엣지 케이스에서는 더 적을 수 있다 — 길이를 가정하지 말 것.
 * `entries` normally holds 10 asks plus 10 bids, but edge cases yield fewer; never assume a length.
 * `simulated`는 항상 true다 — `SimulatedBadge` 표시 의무를 뜻한다.
 * `simulated` is always true, which mandates the `SimulatedBadge`.
 */
export interface OrderBookData {
  symbol: string
  market: Market
  price: number
  entries: OrderBookEntry[]
  simulated: true
}

/** 투자자별 수급 한 줄 (금액이 아니라 시뮬레이션 수량) / One investor-flow row (simulated quantities, not amounts) */
export interface InvestorRow {
  date: string
  individual: number
  foreign: number
  institution: number
}

/**
 * 수급 응답 — 최근 10영업일 / The investor-flow response, the last ten sessions.
 *
 * 이력이 짧으면 10행보다 적을 수 있다 / Fewer than ten rows when the history is short.
 */
export interface InvestorsData {
  symbol: string
  market: Market
  rows: InvestorRow[]
  simulated: true
}

// ---------------------------------------------------------------------------
// 시장 개요 / Overview
// ---------------------------------------------------------------------------

/**
 * 한 시장의 요약 / One market's summary.
 *
 * `advancing`/`declining`은 `change_pct`가 정확히 0인 보합을 어느 쪽에도 넣지 않는다.
 * 상위 리스트는 각각 최대 3건이며, 종목이 적으면 더 짧다.
 * A quote at exactly 0 counts as neither advancing nor declining. Each leader list holds at most three.
 */
export interface MarketSummary {
  advancing: number
  declining: number
  top_gainers: Quote[]
  top_losers: Quote[]
  volume_leaders: Quote[]
}

/** 섹터 평균 등락 / A sector's average move */
export interface SectorRow {
  sector: string
  avg_change_pct: number
  count: number
}

/** 시장 개요 — 지수 + 지표 + 시장요약 + 섹터 / The overview: indices, indicators, summaries and sectors */
export interface Overview {
  indices: IndexQuote[]
  indicators: Indicator[]
  summary: Record<Market, MarketSummary>
  sectors: Record<Market, SectorRow[]>
}

// ---------------------------------------------------------------------------
// AI 분석 / AI analysis
// ---------------------------------------------------------------------------

/** 종목 AI 분석 결과 — `analysis`는 한국어 마크다운 / Stock AI analysis; `analysis` is Korean markdown */
export interface StockAnalysis {
  symbol: string
  analysis: string
}

/** 기사 AI 분석 요청 본문 / The article AI analysis request body */
export interface ArticleAnalysisRequest {
  url: string
  title: string
  language: Language
}

/** 기사 AI 분석 결과 — 요청 필드를 되돌려주고 `analysis`는 한국어 마크다운 / Echoes the request; `analysis` is Korean markdown */
export interface ArticleAnalysis extends ArticleAnalysisRequest {
  analysis: string
}
