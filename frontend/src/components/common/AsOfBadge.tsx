/**
 * 데이터 기준 시각 뱃지 — 백엔드가 stale-while-error로 옛 데이터를 서빙할 때 그 사실을 드러낸다.
 * The as-of badge; it surfaces the fact that the backend served older data under stale-while-error.
 *
 * 신선할 때는(60초 미만) 아무것도 렌더하지 않는다 — 정상 상태를 장식하지 않고 이상만 알린다.
 * While fresh (under 60s) it renders nothing: the normal state needs no decoration, only staleness does.
 *
 * 별도 타이머를 두지 않는다 — 시세 훅이 45초마다 리페치하며 부모를 다시 렌더하므로 그때 갱신된다.
 * It keeps no timer of its own: the quote hooks refetch every 45s and re-render the parent, which is
 * when this recomputes.
 */

/** 이 시간 이상 경과하면 뱃지를 노출한다 / Past this age the badge appears */
const STALE_AFTER_MS = 60_000

const MINUTE_MS = 60_000

export interface AsOfBadgeProps {
  /**
   * envelope의 `asOf` ISO 문자열 — 훅이 로딩/실패 중이면 undefined다.
   * The envelope's `asOf` ISO string; it is undefined while a hook loads or after it fails.
   */
  asOf: string | undefined
}

export function AsOfBadge({ asOf }: AsOfBadgeProps) {
  if (asOf === undefined) return null

  const at = Date.parse(asOf)
  if (Number.isNaN(at)) return null

  // 음수 경과(서버/클라이언트 시계 오차로 asOf가 미래)는 신선한 것으로 취급한다.
  // A negative age (asOf in the future from clock skew) counts as fresh.
  const age = Date.now() - at
  if (age < STALE_AFTER_MS) return null

  return (
    <span className="badge" title={`데이터 기준 시각 ${asOf}`}>
      {Math.floor(age / MINUTE_MS)}분 전 기준
    </span>
  )
}
