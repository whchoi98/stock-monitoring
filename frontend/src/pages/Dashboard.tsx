/**
 * 시장·관심 선택을 URL에 보존한다. 종목 상세에서 돌아와도 보고 있던 시장을 유지한다.
 * Market/watch selection lives in the URL, so returning from a stock restores the workspace.
 */
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'

import { QUOTE_POLL_MS } from '../api/queries.ts'
import type { Market } from '../api/types.ts'
import type { QuoteScope } from '../lib/markets.ts'
import { useOnline } from '../lib/online.ts'
import { useWatchlist } from '../lib/watchlistStore.ts'
import { ScopeTabs } from '../components/common/ScopeTabs.tsx'
import { MacroPanel } from '../components/market/MacroPanel.tsx'
import { MarketPulse } from '../components/market/MarketPulse.tsx'
import { NewsFeed } from '../components/market/NewsFeed.tsx'
import { SectorBars } from '../components/market/SectorBars.tsx'
import { StockTable } from '../components/market/StockTable.tsx'

export default function Dashboard() {
  const [params, setParams] = useSearchParams()
  const market: Market = params.get('market') === 'kr' ? 'kr' : 'us'
  const scope: QuoteScope = params.get('watch') === '1' ? 'watch' : market
  const { symbols } = useWatchlist()
  const client = useQueryClient()
  const online = useOnline()
  const refreshing = useIsFetching({
    predicate: query => query.queryKey[0] === 'overview' || query.queryKey[0] === 'news' ||
      (query.queryKey[0] === 'quotes' && (scope === 'watch' || query.queryKey[1] === market)),
  }) > 0

  const onScopeChange = (next: QuoteScope) => {
    const updated = new URLSearchParams(params)
    if (next === 'watch') {
      updated.set('market', market)
      updated.set('watch', '1')
    } else {
      updated.set('market', next)
      updated.delete('watch')
    }
    setParams(updated)
  }
  const refresh = () => {
    const keys = [
      ['overview'], ['news'],
      ...(scope === 'watch' ? [['quotes', 'us'], ['quotes', 'kr']] : [['quotes', market]]),
    ]
    void Promise.allSettled(keys.map(queryKey => client.invalidateQueries({ queryKey })))
  }

  return (
    <div className="market-workspace">
      <header className="workspace-heading">
        <div className="workspace-title">
          <span className="eyebrow">MARKET WORKSPACE</span>
          <h1>시장 한눈에</h1>
          <p>미국·한국 주요 종목과 시장 뉴스</p>
        </div>
        <div className="workspace-tools">
          <div className="workspace-meta">
            <span><span className="watch-mark" aria-hidden="true">★</span> 관심 {symbols.length}종목</span>
            <span>{QUOTE_POLL_MS / 1000}초마다 자동 갱신</span>
          </div>
          <div className="workspace-controls">
            <ScopeTabs value={scope} onChange={onScopeChange} />
            <button type="button" className="btn workspace-refresh" aria-label="시장 데이터 새로고침" disabled={!online || refreshing} onClick={refresh}>
              <svg className={refreshing ? 'refresh-icon is-refreshing' : 'refresh-icon'} viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M16.4 8A6.5 6.5 0 1 0 16 13M16.4 8V3m0 5h-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {refreshing ? '갱신 중' : '새로고침'}
            </button>
          </div>
        </div>
      </header>
      {scope === 'watch' && (
        <p className="workspace-context">관심 종목은 미국·한국을 함께 표시합니다. 시장 요약은 {market === 'us' ? '미국' : '한국'} 기준입니다.</p>
      )}
      <div className="ws ws-market">
        <div className="area-pulse"><MarketPulse market={market} /></div>
        <div className="area-sectors"><SectorBars market={market} /></div>
        <section className="area-quotes" aria-label="시세 모니터"><StockTable scope={scope} /></section>
        <aside className="market-side" aria-label="시장 뉴스와 경제 지표">
          <div className="area-news"><NewsFeed /></div>
          <div className="area-macro"><MacroPanel /></div>
        </aside>
      </div>
    </div>
  )
}
