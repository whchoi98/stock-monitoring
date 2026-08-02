/**
 * ChangeText 계약 테스트 — 등락 색/화살표 규칙은 화면 전체가 의존하는 약속이므로 여기서 고정한다.
 * ChangeText contract tests; the whole UI leans on the up/down colour and arrow rules pinned here.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ChangeText } from './ChangeText.tsx'

describe('ChangeText', () => {
  // ── 브리프에 명시된 세 케이스 / The three cases the brief specifies ──
  it('상승은 up 클래스 + "▲+1.50" / renders an increase as class up with "▲+1.50"', () => {
    render(<ChangeText value={1.5} />)
    expect(screen.getByText('▲+1.50').classList.contains('up')).toBe(true)
  })

  it('하락은 down 클래스 / renders a decrease with class down', () => {
    render(<ChangeText value={-2} />)
    expect(screen.getByText('▼-2.00').classList.contains('down')).toBe(true)
  })

  it('보합(정확히 0)은 flat 클래스 + "-" / renders flat (exactly 0) as class flat with "-"', () => {
    render(<ChangeText value={0} />)
    expect(screen.getByText('-').classList.contains('flat')).toBe(true)
  })

  // ── 추가 케이스 / Added cases ──
  it('pct를 주면 괄호로 덧붙인다 / appends the percentage in parentheses when pct is given', () => {
    render(<ChangeText value={-2} pct={-1.234} />)
    expect(screen.getByText('▼-2.00 (-1.23%)').classList.contains('down')).toBe(true)
  })

  it('KRW는 소수점 없이 포맷한다 / formats KRW without decimals', () => {
    render(<ChangeText value={1200} pct={0.83} currency="KRW" />)
    expect(screen.getByText('▲+1,200 (+0.83%)').classList.contains('up')).toBe(true)
  })

  it('보합은 pct가 있어도 "-"만 남긴다 / flat stays a bare "-" even with a pct', () => {
    render(<ChangeText value={0} pct={0} />)
    expect(screen.getByText('-').textContent).toBe('-')
  })
})
