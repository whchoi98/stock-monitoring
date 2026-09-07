/**
 * MACRO 패널 — 경제지표(원유·금·환율·금리·암호화폐)를 |등락률| 내림차순 막대로. 크롤은 흘러가고, 이 패널은 읽힌다.
 * The macro panel: the economic indicators (oil, gold, FX, yields, crypto) as bars sorted by |change|. The crawl moves;
 * this panel reads.
 *
 * 막대 길이는 최대 |등락률|에 대한 비율이다 — 절대 폭이 아니라 상대 크기를 읽게 한다 (`SectorBars`와 같은 문법).
 * A bar's length is a ratio of the largest |change|, so it reads as relative magnitude (the `SectorBars` idiom).
 */
import { useQueryClient } from '@tanstack/react-query'

import { useOverview } from '../../api/queries.ts'
import { changeClass, formatIndicatorValue, formatPct } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'

export function MacroPanel() {
  const { data, asOf, isLoading, error } = useOverview()
  const queryClient = useQueryClient()

  // 개요를 쓰는 위젯들이 공유하는 키 (`api/queries.ts`의 `['overview']`) / The key the overview widgets share
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="경제 지표를 불러오지 못했습니다" />

  // 원본 배열은 쿼리 캐시의 것이므로 복사해서 정렬한다 / The array belongs to the query cache, so sort a copy
  const rows = [...(data?.indicators ?? [])].sort(
    (a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct),
  )
  // 0으로 나누지 않는다 — 전 지표가 보합이면 막대는 길이 0이다 / Never divide by zero: all-flat yields zero-length bars
  const peak = Math.max(...rows.map((row) => Math.abs(row.change_pct)), 0)

  return (
    <Panel id="macro" eyebrow="MACRO" title="경제 지표" action={<AsOfBadge asOf={asOf} />}>
      {isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="empty">경제 지표 데이터가 없습니다</p>
      ) : (
        <ul className="macro-list">
          {rows.map((row) => {
            const kind = changeClass(row.change_pct)
            return (
              <li className="macro-row" key={row.symbol}>
                <span className="macro-name" title={row.symbol}>
                  {row.name}
                </span>
                <span className="macro-value">{formatIndicatorValue(row)}</span>
                <span className="sector-track">
                  <span
                    className={`sector-fill ${kind}`}
                    style={{ width: peak === 0 ? 0 : `${((Math.abs(row.change_pct) / peak) * 100).toFixed(1)}%` }}
                  />
                </span>
                <span className={`sector-value ${kind}`}>{formatPct(row.change_pct)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
