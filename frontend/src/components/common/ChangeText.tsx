/**
 * 등락 텍스트 — 화살표 + 변동 금액 (+ 변동률). 색은 `.up/.down/.flat` 클래스(토큰)로만 낸다.
 * Change text: arrow plus change amount (plus percentage). Colour comes only from the
 * `.up/.down/.flat` token classes, never from a hardcoded value.
 */
import { arrow, changeClass, formatChange, formatPct, type Currency } from '../../lib/format.ts'

export interface ChangeTextProps {
  /** 변동 금액 — 부호가 화살표/색을 결정한다 / The change amount; its sign drives arrow and colour */
  value: number
  /** 변동률 (퍼센트 스케일, 1.5 === +1.5%) / Change percentage in percent scale (1.5 === +1.5%) */
  pct?: number
  /** 금액의 통화 — KRW는 소수점 없음. 기본값 USD / Currency of the amount; KRW has no decimals. Defaults to USD */
  currency?: Currency
}

export function ChangeText({ value, pct, currency = 'USD' }: ChangeTextProps) {
  const kind = changeClass(value)

  // 보합(정확히 0)은 "+0.00"이 아니라 대시 하나만 남긴다 — TUI의 `arrow` 규칙과 같은 표기.
  // Flat (exactly 0) collapses to a single dash rather than "+0.00", as the TUI's `arrow` rule does.
  if (kind === 'flat') {
    return <span className={kind}>{arrow(value)}</span>
  }

  const amount = `${arrow(value)}${formatChange(value, currency)}`
  return <span className={kind}>{pct === undefined ? amount : `${amount} (${formatPct(pct)})`}</span>
}
