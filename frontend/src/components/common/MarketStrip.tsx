/**
 * 마켓 스트립 — 상단 sticky 블록의 둘째 줄. 지수는 고정 셀로 항상 보이고, 경제지표는 크롤한다 (터미널 문법).
 * The market strip, the second line of the top sticky block: indices as fixed, always-visible cells and the
 * economic indicators as a crawl (the terminal idiom).
 *
 * 데이터는 셸(App)이 `useOverview()`로 가져와 prop으로 내려준다 — 이 컴포넌트는 순수 표시다. 지수도 지표도
 * 없으면(로딩/실패) 띠를 깔지 않는다 — 앱을 막지도, 빈 띠를 보이지도 않는다.
 * The shell (App) fetches with `useOverview()` and passes the data down; this component is pure display. With
 * neither indices nor indicators (loading or failed) no strip is laid down: the app is neither blocked nor scarred.
 */
import type { IndexQuote, Indicator } from '../../api/types.ts'
import { formatClock } from '../../lib/clock.ts'
import { arrow, changeClass, formatIndicatorValue, formatPct, formatPrice } from '../../lib/format.ts'

export interface MarketStripProps {
  /** 주요 지수 — 로딩/실패 중에는 빈 배열 / The indices; empty while loading or after a failure */
  indices: IndexQuote[]
  /** 경제 지표 — 로딩/실패 중에는 빈 배열 / The indicators; empty while loading or after a failure */
  indicators: Indicator[]
  /**
   * envelope의 `asOf` ISO 문자열 — 우측 기준 시각 칩용. 없거나 파싱 불가면 칩만 빠진다.
   * The envelope's `asOf` ISO string for the right-side as-of chip; absent or unparseable drops only the chip.
   */
  asOf?: string
}

/** 등락률 셀 — 화살표 + 부호付 퍼센트, 보합은 대시 / The change cell: arrow plus signed percentage; flat is a dash */
function ChangePct({ change, pct }: { change: number; pct: number }) {
  const kind = changeClass(change)
  return (
    <span className={`strip-change ${kind}`}>
      {kind === 'flat' ? arrow(change) : `${arrow(change)}${formatPct(pct)}`}
    </span>
  )
}

function StripCell({ name, value, change, pct }: { name: string; value: string; change: number; pct: number }) {
  return (
    <span className="strip-cell">
      <span className="strip-name">{name}</span>
      <span className="strip-value">{value}</span>
      <ChangePct change={change} pct={pct} />
    </span>
  )
}

function IndicatorGroup({ indicators }: Pick<MarketStripProps, 'indicators'>) {
  return (
    <div className="strip-group">
      {indicators.map((indicator) => (
        <StripCell
          key={indicator.symbol}
          name={indicator.name}
          value={formatIndicatorValue(indicator)}
          change={indicator.change}
          pct={indicator.change_pct}
        />
      ))}
    </div>
  )
}

export function MarketStrip({ indices, indicators, asOf }: MarketStripProps) {
  if (indices.length === 0 && indicators.length === 0) return null

  const clock = asOf === undefined ? null : formatClock(asOf)

  return (
    <div className="market-strip">
      {indices.length > 0 && (
        <div className="strip-indices" aria-label="주요 지수">
          {indices.map((index) => (
            <StripCell
              key={index.symbol}
              name={index.name}
              // 지수는 통화가 없다 — 소수 2자리(USD 규칙)로 통일 / Indices carry no currency, so the 2-decimal USD rule applies
              value={formatPrice(index.value, 'USD')}
              change={index.change}
              pct={index.change_pct}
            />
          ))}
        </div>
      )}
      {indicators.length > 0 && (
        <div className="strip-crawl" aria-label="경제 지표">
          {/*
            같은 목록을 두 벌 이어 붙이고 트랙을 -50%까지 밀면 끊김 없이 순환한다. 사본은 순전히 시각용이므로
            aria-hidden으로 중복 낭독을 막는다.
            Two copies of the list plus a track sliding to -50% loop without a gap; the copy is purely visual, so
            aria-hidden keeps screen readers from reading it twice.
          */}
          <div className="strip-track">
            <IndicatorGroup indicators={indicators} />
            <div aria-hidden="true">
              <IndicatorGroup indicators={indicators} />
            </div>
          </div>
        </div>
      )}
      {clock !== null && (
        <span className="strip-asof" title={`데이터 기준 시각 ${asOf}`}>
          {clock} 기준
        </span>
      )}
    </div>
  )
}
