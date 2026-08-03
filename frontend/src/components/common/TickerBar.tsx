/**
 * 하단 고정 경제지표 티커 바 — 지표명 + 값 + 등락을 가로로 무한 스크롤한다 (Toss 문법).
 * The fixed bottom economic-indicator ticker; it scrolls name, value and change horizontally
 * forever (the Toss idiom).
 *
 * 데이터는 셸(App)이 `useOverview()`로 가져와 prop으로 내려준다 — 이 컴포넌트는 순수 표시다.
 * The shell (App) fetches with `useOverview()` and passes them down; this component is pure display.
 */
import type { Indicator } from '../../api/types.ts'
import { formatPrice } from '../../lib/format.ts'
import { ChangeText } from './ChangeText.tsx'

export interface TickerBarProps {
  /** 경제 지표 — 로딩/실패 중에는 빈 배열이 온다 / The indicators; an empty array while loading or after a failure */
  indicators: Indicator[]
  /**
   * envelope의 `asOf` ISO 문자열 — 우측 시각 칩용. 없거나 파싱 불가면 칩만 빠진다.
   * The envelope's `asOf` ISO string for the right-side clock chip; absent or unparseable drops only the chip.
   */
  asOf?: string
}

/**
 * 지표 값 + 단위 — 백엔드 `unit`은 `"$" | "W" | "%" | ""`이고 `$`만 접두사다.
 * The value with its unit; the backend's `unit` is `"$" | "W" | "%" | ""` and only `$` is a prefix.
 */
function formatIndicatorValue(indicator: Indicator): string {
  const value = formatPrice(indicator.value, 'USD')
  return indicator.unit === '$' ? `$${value}` : `${value}${indicator.unit}`
}

/**
 * ISO → 브라우저 로컬 `HH:MM` (24시간). 파싱 불가면 null — 칩을 그리지 않는 신호다.
 * ISO to the browser-local `HH:MM` (24h); null when unparseable, meaning "draw no chip".
 */
function formatClock(iso: string): string | null {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  // hour12: false는 h24 사이클이 되어 00:xx가 24:xx로 렌더된다 (정정 2026-08-03, Task 1 리뷰에서 실증)
  // hour12: false resolves to the h24 cycle, rendering 00:xx as 24:xx (corrected 2026-08-03, proven in the Task 1 review)
  return new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

function TickerItems({ indicators }: Pick<TickerBarProps, 'indicators'>) {
  return (
    <div className="ticker-group">
      {indicators.map((indicator) => (
        <span className="ticker-item" key={indicator.symbol}>
          <span className="ticker-name">{indicator.name}</span>
          <span className="ticker-value">{formatIndicatorValue(indicator)}</span>
          <ChangeText value={indicator.change} pct={indicator.change_pct} />
        </span>
      ))}
    </div>
  )
}

export function TickerBar({ indicators, asOf }: TickerBarProps) {
  // 지표가 아직/끝내 없으면 빈 바를 깔지 않는다 — 앱을 막지도, 빈 띠를 보이지도 않는다.
  // With no indicators (yet, or ever) no empty strip is laid down: the app is neither blocked nor scarred.
  if (indicators.length === 0) return null

  const clock = asOf === undefined ? null : formatClock(asOf)

  return (
    <div className="ticker-bar">
      <div className="ticker-viewport">
        {/*
          같은 목록을 두 벌 이어 붙이고 트랙을 -50%까지 밀면 끊김 없이 순환한다.
          사본은 순전히 시각용이므로 aria-hidden으로 중복 낭독을 막는다.
          Two copies of the list plus a track sliding to -50% loop without a gap; the copy is purely
          visual, so aria-hidden keeps screen readers from reading it twice.
        */}
        <div className="ticker-track">
          <TickerItems indicators={indicators} />
          <div aria-hidden="true">
            <TickerItems indicators={indicators} />
          </div>
        </div>
      </div>
      {clock !== null && (
        <span className="ticker-clock" title={`데이터 기준 시각 ${asOf}`}>
          {clock} 기준
        </span>
      )}
    </div>
  )
}
