/**
 * 시세 표 — 한 시장의 종목을 컬럼 정렬 가능한 표로 보여주고, 행을 누르면 종목 상세로 보낸다.
 * The quote table: one market's stocks as a column-sortable table whose rows open the stock detail.
 *
 * 정렬은 로컬 state다 (서버 재조회 없음). 초기 상태는 "정렬 없음" — 백엔드가 준 순서를 그대로 보여준다.
 * Sorting is local state with no refetch; the initial state is "unsorted", i.e. the backend's own order.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useQuotes } from '../../api/queries.ts'
import type { Market, Quote } from '../../api/types.ts'
import {
  changeClass,
  formatMarketCap,
  formatPct,
  formatPrice,
  formatVolume,
} from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ChangeText } from '../common/ChangeText.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

const MARKET_LABEL: Record<Market, string> = { us: '미국', kr: '한국' }

/** 문자로 정렬하는 컬럼 / Columns sorted as text */
type TextKey = 'symbol' | 'name'
/** 숫자로 정렬하는 컬럼 (`market_cap`은 결측 가능) / Columns sorted as numbers (`market_cap` can be missing) */
type NumericKey = 'price' | 'change' | 'change_pct' | 'market_cap' | 'volume'

type Column = { key: TextKey; label: string; text: true } | { key: NumericKey; label: string; text: false }

/** 스펙 6.2의 컬럼 구성 (Symbol/Name/Price/Change/%/MktCap/Volume) / The column set from spec 6.2 */
const COLUMNS: Column[] = [
  { key: 'symbol', label: '심볼', text: true },
  { key: 'name', label: '종목명', text: true },
  { key: 'price', label: '현재가', text: false },
  { key: 'change', label: '전일대비', text: false },
  { key: 'change_pct', label: '등락률', text: false },
  { key: 'market_cap', label: '시가총액', text: false },
  { key: 'volume', label: '거래량', text: false },
]

type Direction = 'asc' | 'desc'

interface Sort {
  column: Column
  dir: Direction
}

/**
 * 두 시세를 한 컬럼 기준으로 비교 / Compare two quotes on one column.
 *
 * 결측 시총(`null`)은 가장 작은 값으로 취급한다 — 내림차순이면 맨 아래, 오름차순이면 맨 위에 모인다.
 * 스케줄러가 시총을 채우기 전(콜드 스타트 직후)에도 정렬이 깨지지 않아야 한다.
 * A missing cap (`null`) counts as the smallest value, so it collects at the bottom when descending and
 * at the top when ascending; sorting must survive a cold start, before the scheduler fills caps in.
 */
function compare(a: Quote, b: Quote, column: Column): number {
  if (column.text) return a[column.key].localeCompare(b[column.key])
  return (a[column.key] ?? Number.NEGATIVE_INFINITY) - (b[column.key] ?? Number.NEGATIVE_INFINITY)
}

export interface StockTableProps {
  /** 표시할 시장 — 탭 상태는 대시보드가 소유한다 / The market to show; the dashboard owns the tab state */
  market: Market
}

export function StockTable({ market }: StockTableProps) {
  const { data, asOf, isLoading, error } = useQuotes(market)
  const [sort, setSort] = useState<Sort | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  /*
   * F2 훅은 `refetch`를 노출하지 않으므로(계약: `{data, asOf, marketOpen, isLoading, error}`)
   * 재시도는 이 위젯의 쿼리 키만 무효화한다 — 키는 `api/queries.ts`의 `['quotes', market]`과 같아야 한다.
   * The F2 hooks expose no `refetch` (their contract is `{data, asOf, marketOpen, isLoading, error}`), so
   * a retry invalidates just this widget's key, which must mirror `['quotes', market]` in `api/queries.ts`.
   */
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['quotes', market] })
  }

  const rows = useMemo(() => {
    if (data === undefined) return []
    if (sort === null) return data
    const factor = sort.dir === 'asc' ? 1 : -1
    // 원본 배열은 쿼리 캐시의 것이므로 복사해서 정렬한다 / The array belongs to the query cache, so sort a copy
    return [...data].sort((a, b) => factor * compare(a, b, sort.column))
  }, [data, sort])

  /** 같은 컬럼을 다시 누르면 방향만 뒤집는다 / Clicking the same column again only flips the direction */
  const toggle = (column: Column) => {
    setSort((prev) =>
      prev !== null && prev.column.key === column.key
        ? { column, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : // 숫자는 큰 값부터, 이름은 사전순이 자연스럽다 / Numbers read best largest-first, names alphabetically
          { column, dir: column.text ? 'asc' : 'desc' },
    )
  }

  if (error !== null) {
    return <ErrorCard onRetry={retry} message={`${MARKET_LABEL[market]} 시세를 불러오지 못했습니다`} />
  }

  return (
    <Card title={`${MARKET_LABEL[market]} 시세`} action={<AsOfBadge asOf={asOf} />}>
      {isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="empty">표시할 종목이 없습니다</p>
      ) : (
        <div className="table-scroll">
          <table className="stock-table">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={column.text ? undefined : 'cell-number'}
                    aria-sort={
                      sort !== null && sort.column.key === column.key
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button type="button" className="th-sort" onClick={() => toggle(column)}>
                      {column.label}
                      {sort !== null && sort.column.key === column.key && (
                        <span aria-hidden="true">{sort.dir === 'asc' ? ' ↑' : ' ↓'}</span>
                      )}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((quote) => {
                const open = () => navigate(`/stocks/${quote.symbol}`)
                return (
                  <tr
                    key={quote.symbol}
                    className={changeClass(quote.change)}
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(event) => {
                      // 키보드로도 상세에 도달해야 한다 / The detail must be reachable from the keyboard too
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        open()
                      }
                    }}
                  >
                    <td className="cell-symbol">{quote.symbol}</td>
                    <td className="cell-name">{quote.name}</td>
                    <td className="cell-number cell-price">
                      {formatPrice(quote.price, quote.currency)}
                    </td>
                    <td className="cell-number cell-signed">
                      <ChangeText value={quote.change} currency={quote.currency} />
                    </td>
                    <td className="cell-number cell-signed">{formatPct(quote.change_pct)}</td>
                    <td className="cell-number">
                      {formatMarketCap(quote.market_cap, quote.currency)}
                    </td>
                    <td className="cell-number">{formatVolume(quote.volume)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
