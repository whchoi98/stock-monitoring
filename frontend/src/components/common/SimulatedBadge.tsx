/**
 * 시뮬레이션 뱃지 — 호가/수급 패널은 실데이터가 아니므로 이 뱃지 표시가 의무다 (스펙 신뢰 신호).
 * The simulated badge; the order book and investor panels are not real data, so showing it is
 * mandatory (a trust signal in the spec).
 *
 * 눈에 보이지만 튀지 않아야 한다 → 색은 본문색(`--text`)만 쓰고 강조색을 쓰지 않는다.
 * It must be visible yet subdued, so it uses only the body colour (`--text`), never an accent.
 */
export function SimulatedBadge() {
  return (
    <span className="badge" title="실제 시장 데이터가 아닌 시뮬레이션 값입니다">
      시뮬레이션
    </span>
  )
}
