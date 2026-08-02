/**
 * 수급 패널 — 최근일의 개인/외국인/기관 순매수를 가로 막대로, 그 아래 최근 10영업일 표.
 * The investor panel: the latest session's individual, foreign and institutional net buying as horizontal
 * bars, with the last ten sessions in a table below.
 *
 * **시뮬레이션 데이터다** (`InvestorsData.simulated`는 항상 true) — 투자자별 순매수 소스가 없어 백엔드가
 * 거래량에서 파생시킨 값이므로 `SimulatedBadge` 표시가 의무다. 단위는 금액이 아니라 **수량(주)** 이다.
 * **This is simulated data** (`InvestorsData.simulated` is always true): with no investor-flow source the
 * backend derives it from volume, which makes the `SimulatedBadge` mandatory. The unit is a **share count**,
 * not an amount.
 *
 * 행 수를 가정하지 않는다 — 이력이 짧으면 10일보다 적다 (`api/types.ts`).
 * The row count is never assumed: a short history yields fewer than ten sessions (see `api/types.ts`).
 */
import { useQueryClient } from '@tanstack/react-query'

import { useInvestors } from '../../api/queries.ts'
import type { InvestorRow } from '../../api/types.ts'
import { changeClass, formatVolume } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { SimulatedBadge } from '../common/SimulatedBadge.tsx'
import { Spinner } from '../common/Spinner.tsx'

/** 표시 순서와 라벨 / The display order and the labels */
const PARTICIPANTS: { key: keyof Omit<InvestorRow, 'date'>; label: string }[] = [
  { key: 'individual', label: '개인' },
  { key: 'foreign', label: '외국인' },
  { key: 'institution', label: '기관' },
]

export interface InvestorPanelProps {
  /** 종목 심볼 — 그대로 F2 훅에 넘긴다 / The symbol, handed straight to the F2 hook */
  symbol: string
}

export function InvestorPanel({ symbol }: InvestorPanelProps) {
  const { data, asOf, isLoading, error } = useInvestors(symbol)
  const queryClient = useQueryClient()

  /*
   * 재시도는 이 위젯의 쿼리 키만 무효화한다 — 키는 `api/queries.ts`의 `['investors', symbol]`과 같아야 한다.
   * A retry invalidates just this widget's key, which must mirror `['investors', symbol]` in `api/queries.ts`.
   */
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['investors', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="수급을 불러오지 못했습니다" />

  const rows = data?.rows ?? []
  /*
   * 표는 최근 날짜가 위로 오게 뒤집는다 (백엔드는 오래된 날짜부터 준다). 막대는 그 첫 행 = 최근일이다.
   * The table is reversed so the newest session is on top (the backend sends oldest first); the bars read
   * that first row, i.e. the latest session.
   */
  const recent = [...rows].reverse()
  const latest = recent[0]
  /*
   * 막대 길이는 세 주체의 최대 |순매수|에 대한 비율이다 — 절대 수량이 아니라 상대 크기를 읽게 한다.
   * 0으로 나누지 않는다 (셋 다 정확히 0이면 막대는 길이 0이다).
   * A bar's length is a ratio of the largest |net| among the three, so it reads as relative magnitude;
   * never a division by zero (all-zero flows yield zero-length bars).
   */
  const peak =
    latest === undefined
      ? 0
      : Math.max(...PARTICIPANTS.map(({ key }) => Math.abs(latest[key])), 0)

  return (
    <Card
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
                  <span className={`investor-value ${changeClass(value)}`}>
                    {formatVolume(value)}
                  </span>
                </li>
              )
            })}
          </ul>

          {/*
            F4의 `.stock-table`을 재사용하지 않는다 — 그 클래스는 행에 `cursor: pointer`와 호버 배경을
            달아 "누르면 이동한다"고 말하는데 이 표는 클릭 대상이 아니다. 스크롤 래퍼와 `.cell-number`만 공유한다.
            F4's `.stock-table` is deliberately not reused: it puts `cursor: pointer` and a hover background
            on rows, promising navigation this table does not offer. Only the scroll wrapper and
            `.cell-number` are shared.
          */}
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
    </Card>
  )
}
