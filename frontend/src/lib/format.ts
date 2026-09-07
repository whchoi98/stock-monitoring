/**
 * 숫자/통화 포맷 유틸 — TUI(`stock-on-tui/models/stock.py`)의 formatted_* 규칙과 동일 결과를 낸다.
 * Number/currency formatting utilities, matching the TUI's formatted_* rules.
 */

/** 통화 구분 / Currency discriminator */
export type Currency = 'USD' | 'KRW'

/** 값이 없을 때 표시하는 대시 / Dash shown when a value is unavailable */
const EM_DASH = '—'

/** 천 단위 구분 + 고정 소수점 / Thousands separator with fixed decimals */
function group(v: number, fractionDigits: number): string {
  return v.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}

/** 가격 포맷 — KRW는 소수점 없음, USD는 2자리 / Price: no decimals for KRW, 2 for USD */
export function formatPrice(v: number, currency: Currency): string {
  return group(v, currency === 'KRW' ? 0 : 2)
}

/** 변동 금액 — 0 이상이면 "+" 부호 부착 (TUI 규칙) / Change amount, "+" when >= 0 (TUI rule) */
export function formatChange(v: number, currency: Currency): string {
  const sign = v >= 0 ? '+' : ''
  return `${sign}${formatPrice(v, currency)}`
}

/** 변동률 — 부호 포함 2자리 백분율 / Change percentage with sign, 2 decimals */
export function formatPct(v: number): string {
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

/**
 * 시가총액 — KRW는 억/조/경, USD는 $M/B/T. 값이 없거나 0 이하면 "—".
 * Market cap: 억/조/경 for KRW, $M/B/T for USD; "—" when missing or <= 0.
 */
export function formatMarketCap(v: number | null, currency: Currency): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return EM_DASH
  if (currency === 'KRW') {
    if (v >= 1e16) return `${(v / 1e16).toFixed(0)}경`
    if (v >= 1e12) return `${(v / 1e12).toFixed(0)}조`
    if (v >= 1e8) return `${(v / 1e8).toFixed(0)}억`
    return group(v, 0)
  }
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  return `$${group(v, 0)}`
}

/** 거래량 — K/M 축약, 1000 미만은 원본 / Volume abbreviated to K/M; raw below 1,000 */
export function formatVolume(v: number): string {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`
  return group(v, 0)
}

/**
 * 발행 시각 표기 — 목록용으로 짧게 "월. 일. 오전/오후 h:mm" (12시간제).
 * Publication time, kept short for a list: "month. day." plus a 12-hour clock.
 *
 * ko-KR + `hour: '2-digit'`은 12시간제다 (풀 ICU 브라우저는 "8. 2. 오전 12:30", Node는 "8. 2. AM 12:30").
 * F4가 남긴 주석의 "09:30" 예시는 실제 출력이 아니었다 — 여기 옮기면서 표기를 사실대로 고쳤고,
 * 동작(24시간제 전환 등)은 바꾸지 않았다 (F4의 화면 회귀를 만들지 않기 위해).
 * ko-KR with `hour: '2-digit'` is a 12-hour clock (a full-ICU browser renders "8. 2. 오전 12:30", Node
 * "8. 2. AM 12:30"). The "09:30" example in F4's comment was never the real output; this move corrects the
 * description without changing the behaviour (no switch to a 24-hour cycle), so F4's screens do not shift.
 */
const PUBLISHED_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/**
 * 뉴스 발행 시각 / A news item's publication time.
 *
 * 시장 뉴스(F4 `NewsFeed`)와 종목 뉴스(F6 `StockNews`)가 같은 표기를 써야 하므로 여기 둔다.
 * 파싱할 수 없는 시각은 표기하지 않는다 (`null`) — 항목 자체는 그대로 보여준다.
 * Shared by the market feed (F4's `NewsFeed`) and the per-stock feed (F6's `StockNews`) so both read the
 * same way. An unparsable time yields `null` and is simply not shown; the item still renders.
 */
export function formatPublished(published: string): string | null {
  const at = Date.parse(published)
  return Number.isNaN(at) ? null : PUBLISHED_FORMAT.format(at)
}

/**
 * 경제지표 값 + 단위 — 백엔드 `unit`은 `"$" | "W" | "%" | ""`이고 `$`만 접두사다. 마켓 스트립과 MACRO 패널이 공유한다.
 * An indicator's value with its unit; the backend's `unit` is `"$" | "W" | "%" | ""` and only `$` is a prefix. Shared by
 * the market strip and the macro panel.
 */
export function formatIndicatorValue(indicator: { value: number; unit: string }): string {
  const value = formatPrice(indicator.value, 'USD')
  return indicator.unit === '$' ? `$${value}` : `${value}${indicator.unit}`
}

/** 등락 화살표 — 보합(정확히 0)은 "-" / Up/down arrow; exactly 0 is flat "-" */
export function arrow(change: number): '▲' | '▼' | '-' {
  if (change > 0) return '▲'
  if (change < 0) return '▼'
  return '-'
}

/** 등락 CSS 클래스 — 보합(정확히 0)은 본문색 / Change CSS class; exactly 0 uses body color */
export function changeClass(change: number): 'up' | 'down' | 'flat' {
  if (change > 0) return 'up'
  if (change < 0) return 'down'
  return 'flat'
}
