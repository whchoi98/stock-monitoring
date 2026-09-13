/**
 * 데이터 기준 시각 뱃지 — 백엔드가 stale-while-error로 옛 데이터를 서빙할 때 그 사실을 드러낸다.
 * The as-of badge; it surfaces the fact that the backend served older data under stale-while-error.
 *
 * 신선할 때는(60초 미만) 아무것도 렌더하지 않는다 — 정상 상태를 장식하지 않고 이상만 알린다.
 * While fresh (under 60s) it renders nothing: the normal state needs no decoration, only staleness does.
 *
 * **왜 자체 타이머가 필요한가**: 부모의 재렌더에 기댈 수 없다. TanStack Query v5는 기본
 * `structuralSharing: true` + 프롭 트래킹이라, 리페치 결과가 deep-equal이면 같은 참조를 돌려주고
 * 옵저버에게 알리지 않는다. 쿼리 훅의 `unwrap`은 `data`/`isLoading`/`error`만 읽으므로(성공 상태에서
 * `isLoading`은 계속 false) 백엔드가 stale 데이터를 계속 서빙하는 동안 재렌더가 한 번도 일어나지 않는다.
 * 즉 정확히 stale일 때 뱃지가 침묵한다. 그래서 30초마다 자기 자신만 다시 렌더하는 UI 클럭을 둔다.
 * Global Constraints의 "수동 setInterval 금지"는 **데이터 폴링**("폴링: … 항상 TanStack Query로")에
 * 대한 규칙이며, 표시 시각 갱신용 클럭은 데이터를 가져오지 않으므로 그 규칙의 대상이 아니다.
 *
 * **Why it needs its own timer**: a parent re-render cannot be relied on. TanStack Query v5 defaults to
 * `structuralSharing: true` with prop tracking, so a refetch whose result is deep-equal hands back the
 * same reference and notifies no observer. The query hooks' `unwrap` reads only `data`/`isLoading`/`error`
 * (and `isLoading` stays false once loaded), so while the backend keeps serving stale data not a single
 * re-render happens — the badge would stay silent exactly when it matters. Hence a UI clock that
 * re-renders only this component every 30s. The "no manual setInterval" constraint targets *data
 * polling* ("always via TanStack Query"); a display clock fetches nothing and is out of its scope.
 */
import { useEffect, useState } from 'react'

/** 이 시간 이상 경과하면 뱃지를 노출한다 / Past this age the badge appears */
const STALE_AFTER_MS = 60_000

/**
 * UI 클럭 주기 — 임계(60초)의 절반이라 뱃지는 늦어도 age 90초에는 나타나고 표기도 그 간격으로 갱신된다.
 * The UI clock period; being half the 60s threshold, the badge appears by age 90s at the latest and its
 * wording refreshes at the same cadence.
 */
const TICK_MS = 30_000

const MINUTE_MS = 60_000

export interface AsOfBadgeProps {
  /**
   * envelope의 `asOf` ISO 문자열 — 훅이 로딩/실패 중이면 undefined다.
   * The envelope's `asOf` ISO string; it is undefined while a hook loads or after it fails.
   */
  asOf: string | undefined
}

export function AsOfBadge({ asOf }: AsOfBadgeProps) {
  // 값이 아니라 재렌더만 필요하다 — 경과 시간은 렌더 시점의 Date.now()로 계산해야 항상 최신이다.
  // Only a re-render is needed, not a value: the age is computed from Date.now() at render time so it
  // can never lag behind.
  const [, setTick] = useState(0)

  useEffect(() => {
    // asOf가 없으면 계산할 나이도 없다 — 값이 도착하면 이 이펙트가 다시 돌며 클럭을 시작한다.
    // With no asOf there is no age to compute; when one arrives this effect re-runs and starts the clock.
    if (asOf === undefined) return

    const id = setInterval(() => setTick((n) => n + 1), TICK_MS)
    return () => clearInterval(id)
  }, [asOf])

  if (asOf === undefined) return null

  const at = Date.parse(asOf)
  if (Number.isNaN(at)) return null

  // 음수 경과(서버/클라이언트 시계 오차로 asOf가 미래)는 신선한 것으로 취급한다.
  // A negative age (asOf in the future from clock skew) counts as fresh.
  const age = Date.now() - at
  if (age < STALE_AFTER_MS) return null

  const minutes = Math.floor(age / MINUTE_MS)
  const elapsed = minutes >= 1440
    ? `${Math.floor(minutes / 1440)}일`
    : minutes >= 60 ? `${Math.floor(minutes / 60)}시간` : `${minutes}분`
  return (
    <span className="badge" title={`데이터 기준 시각 ${asOf}`}>
      {elapsed} 전 기준
    </span>
  )
}
