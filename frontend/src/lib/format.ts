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
