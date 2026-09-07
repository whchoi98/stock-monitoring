/**
 * 시세 표 (QUOTE MONITOR) — 한 스코프(미국 / 한국 / ★관심)의 종목을 컬럼 정렬 가능한 밀집 표로, 행을 누르면 종목 화면으로.
 * The quote monitor: one scope's stocks (US / KR / ★watch) as a dense, column-sortable table whose rows open the stock
 * screen.
 *
 * 정렬은 로컬 state다 (서버 재조회 없음). 초기 상태는 "정렬 없음" — 백엔드가 준 순서(관심 스코프는 저장 순서)를 그대로 보여준다.
 * 스코프 토글은 패널 머리에 앉는다 — 시장 화면이 `onScopeChange`를 넘길 때만 렌더된다 (표 자체는 스코프를 소유하지 않는다).
 * 첫 열의 ★는 관심 종목 토글이며 행 이동과 분리된다.
 * Sorting is local state with no refetch; the initial state is "unsorted" (the watch scope keeps stored order). The scope
 * toggle sits in the panel head and renders only when the market screen passes `onScopeChange`. The first column's ★
 * toggles the watchlist, separately from row navigation.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { Quote } from '../../api/types.ts'
import { changeClass, formatMarketCap, formatPct, formatPrice, formatVolume } from '../../lib/format.ts'
import { MARKET_LABEL, type QuoteScope } from '../../lib/markets.ts'
import { useScopedQuotes } from '../../lib/scopedQuotes.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ChangeText } from '../common/ChangeText.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { ScopeTabs } from '../common/ScopeTabs.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { StarButton } from '../common/StarButton.tsx'

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
 * 결측 시총(`null`)은 가장 작은 값으로 취급한다 — 스케줄러가 시총을 채우기 전(콜드 스타트 직후)에도 정렬이 깨지지 않는다.
 * A missing cap (`null`) counts as the smallest value, so sorting survives a cold start before caps are filled in.
 */
function compare(a: Quote, b: Quote, column: Column): number {
  if (column.text) return a[column.key].localeCompare(b[column.key])
  return (a[column.key] ?? Number.NEGATIVE_INFINITY) - (b[column.key] ?? Number.NEGATIVE_INFINITY)
}

function titleOf(scope: QuoteScope): string {
  return scope === 'watch' ? '관심 종목' : `${MARKET_LABEL[scope]} 시세`
}

export interface StockTableProps {
  /** 표시할 스코프 / The scope to show */
  scope: QuoteScope
  /** 스코프 토글 — 넘기면 패널 머리에 토글이 생긴다 / The scope toggle; passing it puts the toggle in the panel head */
  onScopeChange?: (scope: QuoteScope) => void
}

export function StockTable({ scope, onScopeChange }: StockTableProps) {
  const { quotes, asOf, isLoading, error, retryKeys } = useScopedQuotes(scope)
  const [sort, setSort] = useState<Sort | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // 재시도는 이 스코프의 시세 키만 무효화한다 (관심 스코프는 두 시장) / The retry invalidates this scope's keys (both markets for the watch scope)
  const retry = () => {
    for (const queryKey of retryKeys) void queryClient.invalidateQueries({ queryKey })
  }

  const rows = useMemo(() => {
    if (quotes === undefined) return []
    if (sort === null) return quotes
    const factor = sort.dir === 'asc' ? 1 : -1
    // 원본 배열은 쿼리 캐시의 것이므로 복사해서 정렬한다 / The array belongs to the query cache, so sort a copy
    return [...quotes].sort((a, b) => factor * compare(a, b, sort.column))
  }, [quotes, sort])

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
    return <ErrorCard onRetry={retry} message={`${titleOf(scope)}를 불러오지 못했습니다`} />
  }

  return (
    <Panel
      id="quote-monitor"
      eyebrow="QUOTE MONITOR"
      title={titleOf(scope)}
      action={
        <>
          {onScopeChange !== undefined && <ScopeTabs value={scope} onChange={onScopeChange} />}
          {rows.length > 0 && <span className="badge">{rows.length}종목</span>}
          <AsOfBadge asOf={asOf} />
        </>
      }
      flush
    >
      {isLoading ? (
        <div className="panel-pad">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <p className="empty panel-pad">
          {scope === 'watch' ? '☆를 눌러 관심 종목을 추가하세요' : '표시할 종목이 없습니다'}
        </p>
      ) : (
        <div className="table-scroll quotes-scroll">
          <table className="stock-table">
            <thead>
              <tr>
                <th scope="col" className="cell-star">
                  <span className="sr-only">관심</span>
                </th>
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
                    <td className="cell-star">
                      <StarButton symbol={quote.symbol} />
                    </td>
                    <td className="cell-symbol">{quote.symbol}</td>
                    <td className="cell-name">{quote.name}</td>
                    <td className="cell-number cell-price">{formatPrice(quote.price, quote.currency)}</td>
                    <td className="cell-number cell-signed">
                      <ChangeText value={quote.change} currency={quote.currency} />
                    </td>
                    <td className="cell-number cell-signed">
                      <span className="pct">{formatPct(quote.change_pct)}</span>
                    </td>
                    <td className="cell-number">{formatMarketCap(quote.market_cap, quote.currency)}</td>
                    <td className="cell-number">{formatVolume(quote.volume)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
