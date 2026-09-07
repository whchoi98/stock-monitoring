/**
 * 수급 패널 (INVESTOR FLOW) — 최근일의 개인/외국인/기관 순매수를 가로 막대로, 그 아래 최근 10영업일 표.
 * The investor-flow panel: the latest session's individual, foreign and institutional net buying as horizontal
 * bars, with the last ten sessions in a table below.
 *
 * **시뮬레이션 데이터다** (`InvestorsData.simulated`는 항상 true) — 백엔드가 거래량에서 파생시킨 값이므로
 * `SimulatedBadge` 표시가 의무다. 단위는 금액이 아니라 **수량(주)** 이다. 행 수를 가정하지 않는다.
 * **This is simulated data** (`InvestorsData.simulated` is always true), derived from volume, which makes the
 * `SimulatedBadge` mandatory. The unit is a **share count**, not an amount. The row count is never assumed.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useInvestors } from '../../api/queries.ts'
import type { InvestorRow } from '../../api/types.ts'
import { changeClass, formatVolume } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { SimulatedBadge } from '../common/SimulatedBadge.tsx'
import { Spinner } from '../common/Spinner.tsx'

/** 표시 순서와 라벨 / The display order and the labels */
const PARTICIPANTS: { key: keyof Omit<InvestorRow, 'date'>; label: string }[] = [
  { key: 'individual', label: '개인' },
  { key: 'foreign', label: '외국인' },
  { key: 'institution', label: '기관' },
]

export interface InvestorPanelProps {
  /** 종목 심볼 — 그대로 훅에 넘긴다 / The symbol, handed straight to the hook */
  symbol: string
}

export function InvestorPanel({ symbol }: InvestorPanelProps) {
  const { data, asOf, isLoading, error } = useInvestors(symbol)
  const queryClient = useQueryClient()

  // 재시도는 이 위젯의 쿼리 키만 무효화한다 — `api/queries.ts`의 `['investors', symbol]` / The retry invalidates just this key
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['investors', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="수급을 불러오지 못했습니다" />

  const rows = data?.rows ?? []
  // 표는 최근 날짜가 위로 (백엔드는 오래된 날짜부터 준다). 막대는 그 첫 행 = 최근일 / Newest first; the bars read the first row
  const recent = [...rows].reverse()
  const latest = recent[0]
  // 막대 길이는 세 주체의 최대 |순매수|에 대한 비율 — 0으로 나누지 않는다 / Bars scale to the largest |net|; never a division by zero
  const peak =
    latest === undefined
      ? 0
      : Math.max(...PARTICIPANTS.map(({ key }) => Math.abs(latest[key])), 0)

  return (
    <Panel
      id="investor-flow"
      eyebrow="INVESTOR FLOW"
      title="투자자 동향"
      action={
        <>
          <SimulatedBadge />
          <AsOfBadge asOf={asOf} />
        </>
      }
    >
      {isLoading ? (
        <Spinner />
      ) : latest === undefined ? (
        <p className="empty">수급 데이터가 없습니다</p>
      ) : (
        <>
          <ul className="investor-bars">
            {PARTICIPANTS.map(({ key, label }) => {
              const value = latest[key]
              return (
                <li className="investor-bar" key={key}>
                  <span className="investor-name">{label}</span>
                  <span className="investor-track">
                    <span
                      className={`investor-fill ${changeClass(value)}`}
                      style={{ width: peak === 0 ? '0%' : `${(Math.abs(value) / peak) * 100}%` }}
                    />
                  </span>
                  <span className={`investor-value ${changeClass(value)}`}>{formatVolume(value)}</span>
                </li>
              )
            })}
          </ul>

          {/* `.stock-table`은 행에 클릭을 약속하므로 재사용하지 않는다 / `.stock-table` promises row navigation, so it is not reused */}
          <div className="table-scroll">
            <table className="investor-table">
              <caption className="investor-caption">최근 {recent.length}영업일 순매수 (주)</caption>
              <thead>
                <tr>
                  <th scope="col">날짜</th>
                  {PARTICIPANTS.map(({ key, label }) => (
                    <th className="cell-number" scope="col" key={key}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    {PARTICIPANTS.map(({ key }) => (
                      <td className={`cell-number ${changeClass(row[key])}`} key={key}>
                        {formatVolume(row[key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  )
}
