/**
 * 섹터 등락 카드 — 섹터별 평균 등락률을 가로 막대로 (백엔드가 |평균| 내림차순 상위 8개를 준다).
 * The sector card: each sector's average change as a horizontal bar (the backend sends the top eight by
 * |average|, already sorted).
 *
 * 막대 길이는 그 시장의 최대 |평균|에 대한 비율이다 — 절대 폭이 아니라 상대 크기를 읽게 한다.
 * A bar's length is a ratio of the market's largest |average|, so it reads as relative magnitude.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useOverview } from '../../api/queries.ts'
import type { Market } from '../../api/types.ts'
import { changeClass, formatPct } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

const MARKET_LABEL: Record<Market, string> = { us: '미국', kr: '한국' }

export interface SectorBarsProps {
  /** 표시할 시장 — 탭 상태는 대시보드가 소유한다 / The market to show; the dashboard owns the tab state */
  market: Market
}

export function SectorBars({ market }: SectorBarsProps) {
  const { data, asOf, isLoading, error } = useOverview()
  const queryClient = useQueryClient()

  // 개요 3위젯이 공유하는 키 (`api/queries.ts`의 `['overview']`) / The key the three overview widgets share
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="섹터 등락을 불러오지 못했습니다" />

  const sectors = data?.sectors[market] ?? []
  // 0으로 나누지 않는다 — 전 섹터가 정확히 보합이면 막대는 길이 0이다 / Never divide by zero: an all-flat market yields zero-length bars
  const peak = Math.max(...sectors.map((row) => Math.abs(row.avg_change_pct)), 0)

  return (
    <Card title={`섹터 등락 · ${MARKET_LABEL[market]}`} action={<AsOfBadge asOf={asOf} />}>
      {isLoading ? (
        <Spinner />
      ) : sectors.length === 0 ? (
        <p className="empty">섹터 데이터가 없습니다</p>
      ) : (
        <ul className="sector-list">
          {sectors.map((row) => (
            <li className="sector-row" key={row.sector}>
              <span className="sector-name">{row.sector}</span>
              <span className="sector-track">
                <span
                  className={`sector-fill ${changeClass(row.avg_change_pct)}`}
                  style={{
                    width:
                      peak === 0
                        ? 0
                        : `${((Math.abs(row.avg_change_pct) / peak) * 100).toFixed(1)}%`,
                  }}
                />
              </span>
              <span className={`sector-value ${changeClass(row.avg_change_pct)}`}>
                {formatPct(row.avg_change_pct)}
              </span>
              <span className="sector-count">{row.count}종목</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
