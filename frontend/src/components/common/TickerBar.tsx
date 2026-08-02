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
}

/**
 * 지표 값 + 단위 — 백엔드 `unit`은 `"$" | "W" | "%" | ""`이고 `$`만 접두사다.
 * The value with its unit; the backend's `unit` is `"$" | "W" | "%" | ""` and only `$` is a prefix.
 */
function formatIndicatorValue(indicator: Indicator): string {
  const value = formatPrice(indicator.value, 'USD')
  return indicator.unit === '$' ? `$${value}` : `${value}${indicator.unit}`
}

function TickerItems({ indicators }: TickerBarProps) {
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

export function TickerBar({ indicators }: TickerBarProps) {
  // 지표가 아직/끝내 없으면 빈 바를 깔지 않는다 — 앱을 막지도, 빈 띠를 보이지도 않는다.
  // With no indicators (yet, or ever) no empty strip is laid down: the app is neither blocked nor scarred.
  if (indicators.length === 0) return null

  return (
    <div className="ticker-bar">
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
  )
}
