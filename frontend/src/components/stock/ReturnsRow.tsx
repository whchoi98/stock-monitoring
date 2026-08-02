/**
 * 기간수익률 — 1주 / 1개월 / 3개월 / 1년 (스펙 6.2 ②).
 * Period returns: one week, one month, three months and one year (spec 6.2 ②).
 *
 * **단위 주의**: `StockDetail.returns`의 값은 이미 **퍼센트 스케일**이다 (1.5 === +1.5%) — 100을 곱하면
 * 안 된다. 같은 응답의 퍼센트 계열 필드(`change_pct`/`day_change_pct`/`dividend_yield`)도 모두 퍼센트
 * 스케일이다 (`api/types.ts`의 2026-08-02 정정 참고).
 * **Unit note**: the values in `StockDetail.returns` are already on a **percent scale** (1.5 === +1.5%) and
 * must not be multiplied by 100. Every other percent-like field in the same response
 * (`change_pct`/`day_change_pct`/`dividend_yield`) is percent-scale too (see the 2026-08-02 correction in
 * `api/types.ts`).
 *
 * **`ChangeText`를 쓰지 않는다**: 그 컴포넌트의 `value`는 *금액*이라 `formatChange`로 통화 포맷된다.
 * 기간수익률에는 금액이 없고 퍼센트만 있으므로, F4의 `SectorBars`가 세운 선례대로
 * `arrow` + `changeClass` + `formatPct`를 직접 조합한다 — 같은 모양(화살표 + 색 있는 부호付 퍼센트)이면서
 * 퍼센트를 원화/달러 금액처럼 찍는 버그가 없다.
 * **`ChangeText` is not used here**: its `value` is an *amount* and gets currency-formatted by
 * `formatChange`. A period return has no amount, only a percentage, so this follows the precedent F4's
 * `SectorBars` set and composes `arrow` + `changeClass` + `formatPct` directly — the same look (an arrow and
 * a coloured signed percentage) without rendering a percentage as if it were won or dollars.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useStock } from '../../api/queries.ts'
import type { Period } from '../../api/types.ts'
import { arrow, changeClass, formatPct } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

/** 표시할 기간과 라벨 — 차트 기간 탭과 같은 순서 / The windows and their labels, in the same order as the chart tabs */
const PERIODS: { value: Period; label: string }[] = [
  { value: '1w', label: '1주' },
  { value: '1m', label: '1개월' },
  { value: '3m', label: '3개월' },
  { value: '1y', label: '1년' },
]

export interface ReturnsRowProps {
  /** 종목 심볼 — 그대로 F2 훅에 넘긴다 / The symbol, handed straight to the F2 hook */
  symbol: string
}

export function ReturnsRow({ symbol }: ReturnsRowProps) {
  const { data, asOf, isLoading, error } = useStock(symbol)
  const queryClient = useQueryClient()

  // 상세를 쓰는 세 위젯이 공유하는 키 (`api/queries.ts`의 `['stock', symbol]`) / The key the three detail widgets share
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="기간수익률을 불러오지 못했습니다" />

  /*
   * 조회 실패 시 `returns` 자체가 null이고, 이력이 짧으면 키별로 null이다 — 어느 쪽이든 "—"다.
   * `returns` is null altogether when the lookup failed, and null per key when the history is short; either
   * way the cell shows an em dash.
   */
  const returns = data?.returns ?? null

  return (
    <Card title="기간수익률" action={<AsOfBadge asOf={asOf} />}>
      {isLoading || data === undefined ? (
        <Spinner />
      ) : (
        <ul className="returns-row">
          {PERIODS.map(({ value, label }) => {
            const pct = returns?.[value] ?? null
            return (
              <li className="returns-item" key={value}>
                <span className="returns-label">{label}</span>
                {pct === null || !Number.isFinite(pct) ? (
                  <span className="returns-value flat">—</span>
                ) : changeClass(pct) === 'flat' ? (
                  /*
                    보합(정확히 0)에 화살표를 붙이면 "-0.00%"가 되어 하락으로 읽힌다 — 부호 없이 낸다.
                    결측의 em 대시("—")와 다른 표기여야 하므로 대시로 접지도 않는다.
                    An arrow on a flat return would read as "-0.00%", i.e. as a fall, so no sign is drawn; nor
                    does it collapse to a dash, which has to stay distinct from the missing case's em dash.
                  */
                  <span className="returns-value flat">0.00%</span>
                ) : (
                  <span className={`returns-value ${changeClass(pct)}`}>
                    {arrow(pct)}
                    {formatPct(pct)}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
