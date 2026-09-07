/**
 * 기간수익률 (RETURNS) — 1주 / 1개월 / 3개월 / 1년, 통계 셀 4개.
 * Period returns as four stat cells: one week, one month, three months and one year.
 *
 * **단위 주의**: `StockDetail.returns`의 값은 이미 **퍼센트 스케일**이다 (1.5 === +1.5%) — 100을 곱하면 안 된다.
 * **`ChangeText`를 쓰지 않는다**: 그 컴포넌트의 `value`는 *금액*이라 통화 포맷된다. 기간수익률에는 퍼센트만 있으므로
 * `arrow` + `changeClass` + `formatPct`를 직접 조합한다.
 * **Unit note**: the values are already percent-scale and must not be multiplied by 100. `ChangeText` is not used
 * because its `value` is an amount; a return has only a percentage, so arrow, class and percentage are composed here.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useStock } from '../../api/queries.ts'
import type { Period } from '../../api/types.ts'
import { arrow, changeClass, formatPct } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Stat } from '../common/Stat.tsx'

/** 표시할 기간과 라벨 — 차트 기간 탭과 같은 순서 / The windows and their labels, in the same order as the chart tabs */
const PERIODS: { value: Period; label: string }[] = [
  { value: '1w', label: '1주' },
  { value: '1m', label: '1개월' },
  { value: '3m', label: '3개월' },
  { value: '1y', label: '1년' },
]

/** 값이 없을 때 표시하는 대시 / The dash for a missing value */
const EM_DASH = '—'

/**
 * 셀 하나의 표기와 색 / One cell's text and tone.
 *
 * 보합(정확히 0)에 화살표를 붙이면 "-0.00%"가 되어 하락으로 읽힌다 — 부호 없이 낸다. 결측의 em 대시와 다른 표기여야
 * 하므로 대시로 접지도 않는다.
 * An arrow on a flat return would read as "-0.00%", i.e. a fall, so no sign is drawn; nor does it collapse to a dash,
 * which must stay distinct from the missing case.
 */
function cell(pct: number | null | undefined): { value: string; tone: 'up' | 'down' | 'flat' } {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return { value: EM_DASH, tone: 'flat' }
  const tone = changeClass(pct)
  if (tone === 'flat') return { value: '0.00%', tone }
  return { value: `${arrow(pct)}${formatPct(pct)}`, tone }
}

export interface ReturnsRowProps {
  /** 종목 심볼 — 그대로 훅에 넘긴다 / The symbol, handed straight to the hook */
  symbol: string
}

export function ReturnsRow({ symbol }: ReturnsRowProps) {
  const { data, asOf, isLoading, error } = useStock(symbol)
  const queryClient = useQueryClient()

  // 상세를 쓰는 위젯들이 공유하는 키 (`api/queries.ts`의 `['stock', symbol]`) / The key the detail widgets share
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="기간수익률을 불러오지 못했습니다" />

  // 조회 실패 시 `returns` 자체가 null이고, 이력이 짧으면 키별로 null이다 — 어느 쪽이든 "—" / Null overall or per key; either way an em dash
  const returns = data?.returns ?? null

  return (
    <Panel eyebrow="RETURNS" title="기간수익률" action={<AsOfBadge asOf={asOf} />}>
      {isLoading || data === undefined ? (
        <Spinner />
      ) : (
        <div className="stat-grid stat-grid-4">
          {PERIODS.map(({ value, label }) => {
            const { value: text, tone } = cell(returns?.[value])
            return <Stat key={value} label={label} value={text} tone={tone} />
          })}
        </div>
      )}
    </Panel>
  )
}
