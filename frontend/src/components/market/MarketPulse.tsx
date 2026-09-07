/**
 * 시장 펄스 패널 — 상승/하락 종목 수(breadth) + 상위 3종 리스트 3개 (상승·하락·거래량).
 * The market-pulse panel: breadth (advancing/declining) plus three leader lists (gainers, losers, volume).
 *
 * **라벨은 정직하게**: 백엔드의 `top_losers`는 "등락률 하위 3종"이므로 전 종목이 상승한 장에서는 상승 종목이
 * 들어올 수 있다(반대도 마찬가지다). 그래서 부호를 가정하는 렌더 로직을 두지 않고, 색·화살표는 각 항목의 값에서
 * `changeClass`/`arrow`가 스스로 결정한다.
 * **Honest labels**: the backend's `top_losers` is "the bottom three by change", so in an all-up market it can hold
 * risers (and vice versa). No rendering logic assumes a sign; `changeClass`/`arrow` derive colour and arrow per value.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useOverview } from '../../api/queries.ts'
import type { Market, Quote } from '../../api/types.ts'
import { arrow, changeClass, formatPct, formatVolume } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { MARKET_LABEL } from '../../lib/markets.ts'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'

interface LeaderListProps {
  label: string
  quotes: Quote[]
  /** 오른쪽에 등락을 붙일지 거래량을 붙일지 / Whether the right-hand metric is the change or the volume */
  metric: 'change' | 'volume'
}

/**
 * 상위 종목 한 줄 — 터미널 관례대로 심볼로 읽고 종목명은 title에 둔다 (세 열이 나란히 앉는 폭에서 종목명은 잘린다).
 * 등락은 부호가 있는 퍼센트만 — 금액까지 붙이면 한 줄이 넘친다. 색·화살표는 각 항목의 값에서 나온다.
 * One leader row, read by symbol as terminals do, with the name in the title (names truncate at three columns). The
 * change is the signed percentage alone; the amount would overflow the line. Colour and arrow come from each value.
 */
function LeaderList({ label, quotes, metric }: LeaderListProps) {
  return (
    <div className="leader-list">
      <p className="leader-label eyebrow">{label}</p>
      <ul className="leader-items">
        {quotes.map((quote) => {
          const kind = changeClass(quote.change)
          return (
            <li className="leader-item" key={quote.symbol}>
              <span className="leader-symbol" title={quote.name}>
                {quote.symbol}
              </span>
              {metric === 'change' ? (
                <span className={`leader-metric ${kind}`}>
                  {kind === 'flat' ? arrow(quote.change) : `${arrow(quote.change)}${formatPct(quote.change_pct)}`}
                </span>
              ) : (
                <span className="leader-metric">{formatVolume(quote.volume)}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export interface MarketPulseProps {
  /** 표시할 시장 — 탭 상태는 시장 화면이 소유한다 / The market to show; the market screen owns the tab state */
  market: Market
}

export function MarketPulse({ market }: MarketPulseProps) {
  const { data, asOf, isLoading, error } = useOverview()
  const queryClient = useQueryClient()

  // 개요를 쓰는 위젯들이 공유하는 키 (`api/queries.ts`의 `['overview']`) / The key the overview widgets share
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="시장 요약을 불러오지 못했습니다" />

  const summary = data?.summary[market]
  const breadth = summary === undefined ? 0 : summary.advancing + summary.declining

  return (
    <Panel eyebrow="MARKET PULSE" title={`시장 요약 · ${MARKET_LABEL[market]}`} action={<AsOfBadge asOf={asOf} />}>
      {isLoading ? (
        <Spinner />
      ) : summary === undefined ? (
        <p className="empty">시장 요약 데이터가 없습니다</p>
      ) : (
        <>
          <div className="breadth">
            <span className="up">상승 {summary.advancing}</span>
            <span className="down">하락 {summary.declining}</span>
            <span className="breadth-total">{breadth} 종목</span>
          </div>
          {/*
            보합만 있는 장(상승 0 + 하락 0)에서는 비율을 만들 수 없으므로 막대를 그리지 않는다.
            트랙은 하락색, 채움은 상승색 — 색은 클래스가 정하고 CSS가 currentColor로 칠한다.
            An all-flat market (0 up, 0 down) yields no ratio, so no bar is drawn. The track takes the down colour
            and the fill the up colour: classes decide, CSS paints them via currentColor.
          */}
          {breadth > 0 && (
            <div className="breadth-bar down">
              <span
                className="breadth-fill up"
                style={{ width: `${((summary.advancing / breadth) * 100).toFixed(1)}%` }}
              />
            </div>
          )}
          <div className="leader-lists">
            <LeaderList label="상승 상위" quotes={summary.top_gainers} metric="change" />
            <LeaderList label="하락 상위" quotes={summary.top_losers} metric="change" />
            <LeaderList label="거래량 상위" quotes={summary.volume_leaders} metric="volume" />
          </div>
        </>
      )}
    </Panel>
  )
}
