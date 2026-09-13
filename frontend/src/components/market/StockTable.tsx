/**
 * 시세 표 (QUOTE MONITOR) — 검색·섹터·등락 필터와 정렬을 같은 행 목록에 적용하고 그 순서대로 CSV를 내보낸다.
 * The quote monitor applies search, sector, movement and sorting to one row list, also used for CSV export.
 *
 * 기본 순서는 서버/관심 저장 순서다. 보기 설정은 시장별로 초기화하고 밀도만 localStore에 기억한다.
 * 갱신 실패에도 기존 시세와 조작을 남긴다. 심볼 링크·별·행의 키보드 이동은 서로 간섭하지 않는다.
 * The default is source/watch order. A scope change resets filters and sorting; only density persists in localStore.
 * Cached quotes remain usable after refresh failures. Native links, stars and keyboard row navigation stay independent.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { changeClass, formatMarketCap, formatPct, formatPrice, formatVolume } from '../../lib/format.ts'
import { MARKET_LABEL, type QuoteScope } from '../../lib/markets.ts'
import { downloadQuoteCsv } from '../../lib/quoteCsv.ts'
import { filterQuotes, quoteSectors, sortQuotes, type QuoteMovement, type QuoteSort, type QuoteSortKey } from '../../lib/quoteFilter.ts'
import { quoteDensityStore, useQuoteDensity } from '../../lib/quotePreferences.ts'
import { useScopedQuotes } from '../../lib/scopedQuotes.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ChangeText } from '../common/ChangeText.tsx'
import { DataNotice } from '../common/DataNotice.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { ScopeTabs } from '../common/ScopeTabs.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { StarButton } from '../common/StarButton.tsx'

interface Column {
  key: QuoteSortKey
  label: string
  text: boolean
}

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

const MOVEMENTS: { value: QuoteMovement; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'up', label: '상승' },
  { value: 'down', label: '하락' },
  { value: 'flat', label: '보합' },
]

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
  return <QuoteWorkbench key={scope} scope={scope} onScopeChange={onScopeChange} />
}

function QuoteWorkbench({ scope, onScopeChange }: StockTableProps) {
  const { quotes, asOf, isLoading, error, retryKeys } = useScopedQuotes(scope)
  const [query, setQuery] = useState('')
  const [sector, setSector] = useState('')
  const [movement, setMovement] = useState<QuoteMovement>('all')
  const [sort, setSort] = useState<QuoteSort | null>(null)
  const [allColumns, setAllColumns] = useState(false)
  const density = useQuoteDensity()
  const searchInput = useRef<HTMLInputElement>(null)
  const resultsId = useId()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // 재시도는 이 스코프의 시세 키만 무효화한다 (관심 스코프는 두 시장) / The retry invalidates this scope's keys (both markets for the watch scope)
  const retry = () => {
    for (const queryKey of retryKeys) void queryClient.invalidateQueries({ queryKey })
  }

  const sectors = useMemo(() => quoteSectors(quotes ?? []), [quotes])
  const rows = useMemo(
    () => sortQuotes(filterQuotes(quotes ?? [], { query, sector, movement }), sort),
    [quotes, query, sector, movement, sort],
  )
  const hasQuotes = quotes !== undefined && quotes.length > 0
  const customized = query !== '' || sector !== '' || movement !== 'all' || sort !== null

  const resetView = () => {
    setQuery('')
    setSector('')
    setMovement('all')
    setSort(null)
    searchInput.current?.focus()
  }

  /** 같은 컬럼을 다시 누르면 방향만 뒤집는다 / Clicking the same column again only flips the direction */
  const toggle = (column: Column) => {
    setSort((prev) =>
      prev !== null && prev.key === column.key
        ? { key: column.key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : // 숫자는 큰 값부터, 이름은 사전순이 자연스럽다 / Numbers read best largest-first, names alphabetically
          { key: column.key, direction: column.text ? 'asc' : 'desc' },
    )
  }

  return (
    <Panel
      id="quote-monitor"
      eyebrow="QUOTE MONITOR"
      title={titleOf(scope)}
      action={
        <>
          {onScopeChange !== undefined && <ScopeTabs value={scope} onChange={onScopeChange} />}
          <button
            type="button"
            className="btn quote-columns"
            aria-label={allColumns ? '핵심 열 보기' : '전체 열 보기'}
            aria-pressed={allColumns}
            onClick={() => setAllColumns(value => !value)}
          >
            {allColumns ? '핵심 열' : '전체 열'}
          </button>
          <AsOfBadge asOf={asOf} />
        </>
      }
      flush
    >
      <div className="quote-toolbar" role="group" aria-label="시세 보기 설정">
        <label className="quote-field quote-search">
          <span>종목 검색</span>
          <input
            ref={searchInput}
            className="filter-input"
            type="search"
            placeholder="심볼 · 한글 · 초성 · 영문"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-describedby={hasQuotes ? resultsId : undefined}
          />
        </label>
        <label className="quote-field">
          <span>섹터</span>
          <select className="filter-input" value={sector} onChange={(event) => setSector(event.target.value)}>
            <option value="">전체 섹터</option>
            {sector !== '' && !sectors.includes(sector) && <option value={sector}>{sector} (0종목)</option>}
            {sectors.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <div className="quote-field">
          <span>등락</span>
          <div className="tabs quote-movement" role="group" aria-label="등락 필터">
            {MOVEMENTS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={movement === value ? 'tab tab-active' : 'tab'}
                aria-pressed={movement === value}
                onClick={() => setMovement(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="quote-field quote-density-field">
          <span>표 밀도</span>
          <div className="tabs quote-density" role="group" aria-label="표 밀도">
            <button
              type="button"
              className={density === 'comfortable' ? 'tab tab-active' : 'tab'}
              aria-pressed={density === 'comfortable'}
              onClick={() => quoteDensityStore.set('comfortable')}
            >
              여유롭게
            </button>
            <button
              type="button"
              className={density === 'compact' ? 'tab tab-active' : 'tab'}
              aria-pressed={density === 'compact'}
              onClick={() => quoteDensityStore.set('compact')}
            >
              촘촘하게
            </button>
          </div>
        </div>
        <div className="quote-actions">
          <button type="button" className="btn" aria-label="시세 보기 초기화" disabled={!customized} onClick={resetView}>
            초기화
          </button>
          <button
            type="button"
            className="btn"
            disabled={rows.length === 0}
            onClick={() => downloadQuoteCsv(rows, `quotes-${scope}.csv`)}
          >
            CSV 내보내기
          </button>
        </div>
        {quotes !== undefined && (
          <span id={resultsId} className="quote-results" role="status" aria-label="시세 검색 결과" aria-atomic="true">
            표시 {rows.length} / {quotes.length}종목
          </span>
        )}
      </div>
      {hasQuotes && <DataNotice error={error} onRetry={retry} />}
      {!hasQuotes && error !== null ? (
        <ErrorCard onRetry={retry} message={`${titleOf(scope)}를 불러오지 못했습니다`} />
      ) : !hasQuotes && isLoading ? (
        <div className="panel-pad">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <div className="empty panel-pad quote-empty">
          <p>
            {hasQuotes
              ? '조건에 맞는 종목이 없습니다'
              : scope === 'watch' ? '☆를 눌러 관심 종목을 추가하세요' : '표시할 종목이 없습니다'}
          </p>
          {hasQuotes && <p>검색어나 필터를 변경하거나 보기를 초기화하세요.</p>}
        </div>
      ) : (
        <div className="table-scroll quotes-scroll">
          <table className={`stock-table quote-table--${density}${allColumns ? ' quote-table--all-columns' : ''}`}>
            <caption className="sr-only">{titleOf(scope)} 종목 목록</caption>
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
                      sort !== null && sort.key === column.key
                        ? sort.direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button type="button" className="th-sort" onClick={() => toggle(column)}>
                      {column.label}
                      {sort !== null && sort.key === column.key && (
                        <span aria-hidden="true">{sort.direction === 'asc' ? ' ↑' : ' ↓'}</span>
                      )}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((quote) => {
                const path = `/stocks/${encodeURIComponent(quote.symbol)}`
                return (
                  <tr
                    key={quote.symbol}
                    className={changeClass(quote.change)}
                    tabIndex={0}
                    onClick={(event) => {
                      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
                      // 링크/버튼의 기본 동작을 보존한다 / Preserve native link and button behavior.
                      if ((event.target as Element).closest('a, button')) return
                      navigate(path)
                    }}
                    onKeyDown={(event) => {
                      // 행 자체에 포커스가 있을 때만 동작한다 / Only handle keys aimed at the row itself.
                      if (event.target !== event.currentTarget || event.nativeEvent.isComposing ||
                          event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        navigate(path)
                      }
                    }}
                  >
                    <td className="cell-star">
                      <StarButton symbol={quote.symbol} />
                    </td>
                    <td className="cell-symbol"><Link to={path}>{quote.symbol}</Link></td>
                    <td className="cell-name" title={quote.name}>
                      <Link to={path}>{quote.name_ko?.trim() || quote.name}</Link>
                    </td>
                    <td className="cell-number cell-price">
                      <span>{formatPrice(quote.price, quote.currency)}</span>
                      {' '}<span className="quote-currency">{quote.currency}</span>
                    </td>
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
