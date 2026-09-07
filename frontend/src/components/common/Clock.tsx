/**
 * KST 시계 — 상태 바 우측. 1초마다 자기 자신만 다시 렌더하는 UI 클럭이다.
 * The KST clock on the status bar's right; a UI clock that re-renders only itself once a second.
 *
 * "수동 setInterval 금지"는 **데이터 폴링**에 대한 규칙이다 (`AsOfBadge`와 같은 근거). 이 클럭은 데이터를
 * 가져오지 않는다. 시장 시각(서울)을 고정으로 보이는 이유: 사용자가 어디에 있든 장 시간표는 KST로 읽는다.
 * The "no manual setInterval" constraint targets *data polling* (the same reasoning as `AsOfBadge`); this clock
 * fetches nothing. It shows market time (Seoul) regardless of where the user is, because the trading calendar is
 * read in KST.
 */
import { useEffect, useState } from 'react'

import { formatKstClock } from '../../lib/clock.ts'

const TICK_MS = 1_000

export function Clock() {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <time className="clock" dateTime={new Date(now).toISOString()}>
      {formatKstClock(now)} KST
    </time>
  )
}
