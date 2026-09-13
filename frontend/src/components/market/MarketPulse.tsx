/**
 * 시세 표와 같은 캐시로 집계하는 시장 요약. 보합을 포함하며 추적 종목의 범위를 명시한다.
 * Market breadth and leaders from the same quotes as the table, including unchanged stocks.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { useQuotes } from '../../api/queries.ts'
import type { Market } from '../../api/types.ts'
import { changeClass, formatPct, formatVolume } from '../../lib/format.ts'
import { MARKET_LABEL } from '../../lib/markets.ts'
import { summarizeQuotes } from '../../lib/marketSummary.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { DataNotice } from '../common/DataNotice.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { MarketStatus } from '../common/MarketStatus.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'

const LEADERS = [
  { key: 'gainers', label: '상승 상위', empty: '상승 종목이 없습니다' },
  { key: 'losers', label: '하락 상위', empty: '하락 종목이 없습니다' },
  { key: 'volume', label: '거래량 상위', empty: '거래량 데이터가 없습니다' },
] as const
type Leaders = typeof LEADERS[number]['key']

export function MarketPulse({ market }: { market: Market }) {
  const { data, asOf, isLoading, marketOpen, error } = useQuotes(market)
  const client = useQueryClient()
  const [leaders, setLeaders] = useState<Leaders>('gainers')
  const summary = useMemo(() => summarizeQuotes(data ?? []), [data])
  const retry = () => { void client.invalidateQueries({ queryKey: ['quotes', market] }) }
  const selected = LEADERS.find(item => item.key === leaders)!

  return (
    <Panel
      id="market-pulse"
      eyebrow="MARKET PULSE"
      title={`시장 요약 · ${MARKET_LABEL[market]}`}
      action={<><MarketStatus market={market} marketOpen={error === null ? marketOpen : undefined} /><AsOfBadge asOf={asOf} /></>}
    >
      {error !== null && data === undefined ? (
        <ErrorCard onRetry={retry} message="시장 요약을 불러오지 못했습니다" />
      ) : isLoading ? (
        <Spinner />
      ) : summary.total === 0 ? (
        <p className="empty">시장 요약 데이터가 없습니다</p>
      ) : (
        <>
          <DataNotice error={error} onRetry={retry} />
          <div className="pulse-layout">
            <div className="pulse-breadth">
              <span className="pulse-caption">추적 종목 중 상승 비중</span>
              <p className="pulse-ratio">{summary.advancingPct?.toFixed(0)}<span>%</span></p>
              <div className="pulse-distribution" role="img" aria-label={`상승 ${summary.advancing} · 보합 ${summary.unchanged} · 하락 ${summary.declining}`}>
                <span className="pulse-segment up" style={{ flex: summary.advancing }} />
                <span className="pulse-segment flat" style={{ flex: summary.unchanged }} />
                <span className="pulse-segment down" style={{ flex: summary.declining }} />
              </div>
              <dl className="pulse-counts">
                <div><dt><i className="up" />상승</dt><dd className="up">{summary.advancing}</dd></div>
                <div><dt><i className="flat" />보합</dt><dd>{summary.unchanged}</dd></div>
                <div><dt><i className="down" />하락</dt><dd className="down">{summary.declining}</dd></div>
              </dl>
              <p className="pulse-universe">추적 {summary.total}종목 기준</p>
            </div>
            <div className="pulse-leaders">
              <div className="tabs" role="group" aria-label="주요 종목 순위">
                {LEADERS.map(item => (
                  <button key={item.key} type="button" className={leaders === item.key ? 'tab tab-active' : 'tab'} aria-pressed={leaders === item.key} onClick={() => setLeaders(item.key)}>
                    {item.label}
                  </button>
                ))}
              </div>
              {summary[leaders].length === 0 ? <p className="empty">{selected.empty}</p> : (
                <ol className="pulse-leader-list">
                  {summary[leaders].map((quote, index) => (
                    <li key={quote.symbol}>
                      <Link className="pulse-leader" to={`/stocks/${encodeURIComponent(quote.symbol)}`}>
                        <span className="pulse-rank">{index + 1}</span>
                        <span className="pulse-stock"><strong>{quote.name_ko ?? quote.name}</strong><span className="mono">{quote.symbol}</span></span>
                        <span className={`pulse-metric ${leaders === 'volume' ? '' : changeClass(quote.change_pct)}`}>
                          {leaders === 'volume' ? formatVolume(quote.volume) : formatPct(quote.change_pct)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </>
      )}
    </Panel>
  )
}
