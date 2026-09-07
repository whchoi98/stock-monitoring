/**
 * 장 상태 표시 — envelope의 `marketOpen`(KR 또는 US 개장)을 점 + 라벨로.
 * The market-state indicator: the envelope's `marketOpen` (KR or US open) as a dot plus a label.
 *
 * **`marketOpen`을 꾸미지 않는다**: 첫 로딩 중이거나 실패 뒤에는 undefined이고, 그때는 "확인 중"이다 —
 * 모르는 것과 장이 닫힌 것은 다르다 (`api/queries.ts`의 규칙). 점의 초록(`--ok`)은 상태 전용이며 등락색이 아니다.
 * **`marketOpen` is never faked**: it is undefined while first loading or after a failure, and that reads as
 * "확인 중" — unknown and closed are different things (the rule in `api/queries.ts`). The dot's green (`--ok`) is a
 * state colour, never a price direction.
 */
export interface MarketStatusProps {
  marketOpen: boolean | undefined
}

export function MarketStatus({ marketOpen }: MarketStatusProps) {
  const state = marketOpen === undefined ? 'unknown' : marketOpen ? 'open' : 'closed'
  const label = state === 'open' ? '장중' : state === 'closed' ? '장마감' : '확인 중'
  return (
    <span
      className={`status status-${state}`}
      title="한국 또는 미국 정규장 개장 여부 / Whether the Korean or the US regular session is open"
    >
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  )
}
