/**
 * 하단 상태 바 — 장 상태 · 데이터 출처 · 폴링 주기 · 시뮬레이션 안내 · 기준 시각 · KST 시계 (터미널 문법).
 * The bottom status bar: market state, data source, polling cadence, the simulation notice, the as-of time and
 * the KST clock (the terminal idiom).
 *
 * 폴링 주기는 `api/queries.ts`의 상수를 그대로 읽어 표기한다 — 문구가 코드와 어긋날 수 없다.
 * The polling cadence is rendered from the constants in `api/queries.ts`, so the wording cannot drift from the code.
 */
import { NEWS_POLL_MS, QUOTE_POLL_MS } from '../../api/queries.ts'
import { formatClock } from '../../lib/clock.ts'
import { Clock } from './Clock.tsx'
import { MarketStatus } from './MarketStatus.tsx'

export interface StatusBarProps {
  /** envelope의 `marketOpen` — 로딩/실패 중에는 undefined / The envelope's `marketOpen`; undefined while loading or after a failure */
  marketOpen: boolean | undefined
  /** envelope의 `asOf` — 기준 시각 칩용 / The envelope's `asOf`, for the as-of chip */
  asOf?: string
}

export function StatusBar({ marketOpen, asOf }: StatusBarProps) {
  const asOfClock = asOf === undefined ? null : formatClock(asOf)

  return (
    <footer className="statusbar">
      <MarketStatus marketOpen={marketOpen} />
      <span className="status">
        DATA <strong>Yahoo Finance</strong>
      </span>
      <span className="status">
        시세 {QUOTE_POLL_MS / 1000}s · 뉴스 {NEWS_POLL_MS / 1000}s 폴링
      </span>
      <span className="status">호가·수급 시뮬레이션</span>
      <span className="statusbar-right">
        {asOfClock !== null && (
          <span className="status" title={`데이터 기준 시각 ${asOf}`}>
            기준 {asOfClock}
          </span>
        )}
        <Clock />
      </span>
    </footer>
  )
}
