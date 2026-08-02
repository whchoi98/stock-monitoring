/**
 * 시장 요약 카드 — 상승/하락 종목 수(breadth) + 상위 3종 리스트 3개 (스펙 6.2).
 * The market summary card: breadth (advancing/declining) plus three leader lists (spec 6.2).
 *
 * **라벨은 정직하게**: 백엔드의 `top_losers`는 "등락률 하위 3종"이므로 전 종목이 상승한 장에서는
 * 상승 종목이 들어올 수 있다(반대도 마찬가지다). 그래서 부호를 가정하는 렌더 로직을 두지 않고,
 * 색·화살표는 각 항목의 값에서 `ChangeText`가 스스로 결정한다.
 * **Honest labels**: the backend's `top_losers` is "the bottom three by change", so in an all-up market it
 * can hold risers (and vice versa). No rendering logic assumes a sign; `ChangeText` derives colour and
 * arrow from each item's own value.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useOverview } from '../../api/queries.ts'
import type { Market, Quote } from '../../api/types.ts'
import { formatVolume } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ChangeText } from '../common/ChangeText.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

const MARKET_LABEL: Record<Market, string> = { us: '미국', kr: '한국' }

interface LeaderListProps {
  label: string
  quotes: Quote[]
  /** 오른쪽에 등락을 붙일지 거래량을 붙일지 / Whether the right-hand metric is the change or the volume */
  metric: 'change' | 'volume'
}

function LeaderList({ label, quotes, metric }: LeaderListProps) {
  return (
    <div className="leader-list">
      <p className="leader-label">{label}</p>
      <ul className="leader-items">
        {quotes.map((quote) => (
          <li className="leader-item" key={quote.symbol}>
            <span className="leader-name" title={quote.symbol}>
              {quote.name}
            </span>
            {metric === 'change' ? (
              <ChangeText value={quote.change} pct={quote.change_pct} currency={quote.currency} />
            ) : (
              <span className="leader-volume">{formatVolume(quote.volume)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface MarketSummaryProps {
  /** 표시할 시장 — 탭 상태는 대시보드가 소유한다 / The market to show; the dashboard owns the tab state */
  market: Market
}

export function MarketSummary({ market }: MarketSummaryProps) {
  const { data, asOf, isLoading, error } = useOverview()
  const queryClient = useQueryClient()

  // 개요 3위젯이 공유하는 키 (`api/queries.ts`의 `['overview']`) / The key the three overview widgets share
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="시장 요약을 불러오지 못했습니다" />

  const summary = data?.summary[market]
  const breadth = summary === undefined ? 0 : summary.advancing + summary.declining

  return (
    <Card title={`시장 요약 · ${MARKET_LABEL[market]}`} action={<AsOfBadge asOf={asOf} />}>
      {isLoading ? (
        <Spinner />
      ) : summary === undefined ? (
        <p className="empty">시장 요약 데이터가 없습니다</p>
      ) : (
        <>
          <div className="breadth">
            <span className="up">상승 {summary.advancing}</span>
            <span className="down">하락 {summary.declining}</span>
          </div>
          {/*
            보합만 있는 장(상승 0 + 하락 0)에서는 비율을 만들 수 없으므로 막대를 그리지 않는다.
            트랙은 하락색, 채움은 상승색 — 색은 클래스가 정하고 CSS가 currentColor로 칠한다.
            An all-flat market (0 up, 0 down) yields no ratio, so no bar is drawn. The track takes the down
            colour and the fill the up colour: classes decide, and CSS paints them via currentColor.
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
    </Card>
  )
}
