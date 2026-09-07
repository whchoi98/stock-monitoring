/**
 * 하단 상태 바 — 장 상태 · 오프라인 표시 · 데이터 출처 · 폴링 주기 · 시뮬레이션 안내 · 대기 알림 수 · 기준 시각 · KST 시계 · 레이아웃 초기화.
 * The bottom status bar: market state, the offline badge, data source, polling cadence, the simulation notice, pending
 * alerts, the as-of time, the KST clock and the layout reset.
 *
 * 폴링 주기는 `api/queries.ts`의 상수를 그대로 읽어 표기한다 — 문구가 코드와 어긋날 수 없다.
 * The polling cadence is rendered from the constants in `api/queries.ts`, so the wording cannot drift from the code.
 */
import { NEWS_POLL_MS, QUOTE_POLL_MS } from '../../api/queries.ts'
import { useAlerts } from '../../lib/alertsStore.ts'
import { formatClock } from '../../lib/clock.ts'
import { useOnline } from '../../lib/online.ts'
import { resetPanels, useCollapsedCount } from '../../lib/panelStore.ts'
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
  const pendingAlerts = useAlerts().filter((alert) => alert.triggeredAt === undefined).length
  const collapsed = useCollapsedCount()
  const online = useOnline()

  return (
    <footer className="statusbar">
      <MarketStatus marketOpen={marketOpen} />
      {/* 서비스 워커가 셸을 오프라인에서도 열어 주므로 데이터가 멈춘 이유를 알린다 / The worker opens the shell offline, so say why the data stopped */}
      {!online && (
        <span className="status status-offline" title="네트워크 연결이 끊겼습니다 — 마지막 데이터가 표시됩니다">
          오프라인
        </span>
      )}
      <span className="status">
        DATA <strong>Yahoo Finance</strong>
      </span>
      {/* 좁은 화면에서는 부차 정보 칩을 숨겨 바를 한 줄로 유지한다 (토스트 위치가 바 높이를 가정) / Secondary chips hide on narrow screens so the bar stays one line (toast placement assumes its height) */}
      <span className="status status-secondary">
        시세 {QUOTE_POLL_MS / 1000}s · 뉴스 {NEWS_POLL_MS / 1000}s 폴링
      </span>
      <span className="status status-secondary">호가·수급 시뮬레이션</span>
      {pendingAlerts > 0 && (
        <span className="status" title="대기 중인 가격 알림 (이 브라우저에 저장)">
          알림 {pendingAlerts}
        </span>
      )}
      <span className="statusbar-right">
        {collapsed > 0 && (
          <button type="button" className="btn btn-ghost" onClick={resetPanels}>
            레이아웃 초기화
          </button>
        )}
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
