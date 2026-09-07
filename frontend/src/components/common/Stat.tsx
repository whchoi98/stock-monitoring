/**
 * 통계 셀 — 라벨(대문자 소형) 위, 값(고정폭) 아래. 종목 헤더·핵심 지표·기간수익률이 같은 셀을 쓴다.
 * A stat cell: a small uppercase label over a monospaced value, shared by the quote header, the fundamentals and
 * the period returns.
 */
export interface StatProps {
  label: string
  value: string
  /** 값의 방향색 — 등락값에만 준다 / The value's direction colour, for changes only */
  tone?: 'up' | 'down' | 'flat'
}

export function Stat({ label, value, tone }: StatProps) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={tone === undefined ? 'stat-value' : `stat-value ${tone}`}>{value}</span>
    </div>
  )
}
