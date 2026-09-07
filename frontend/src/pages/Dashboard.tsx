/**
 * 시장 워크스페이스 `/` — 시장 펄스 · 섹터 등락 · 경제 지표(MACRO) · 시세 표(세 칸) · 뉴스 와이어(우측 열, sticky).
 * The market workspace at `/`: market pulse, sector heat, the macro panel, the quote monitor (three cells) and the news
 * wire (right column, sticky).
 *
 * 데이터는 각 위젯이 자기 훅으로 직접 가져간다 (개요를 쓰는 세 위젯은 쿼리 키 `['overview']`를 셸의 스트립과 공유하므로
 * 요청은 한 번만 나간다). 이 페이지가 소유하는 상태는 시세 표의 **스코프**(미국 / 한국 / ★관심)와 **마지막 시장**이다 —
 * 펄스·섹터는 시장별 데이터라 관심 스코프에서는 마지막으로 본 시장을 유지한다.
 * Each widget fetches through its own hook; the three overview widgets share the `['overview']` key with the shell's
 * strip, so exactly one request goes out. The page owns the quote monitor's **scope** (US / KR / ★watch) and the **last
 * market**: pulse and sectors are per-market data, so in the watch scope they keep the market last viewed.
 */
import { useState } from 'react'

import type { Market } from '../api/types.ts'
import { marketOfScope, type QuoteScope } from '../lib/markets.ts'
import { MacroPanel } from '../components/market/MacroPanel.tsx'
import { MarketPulse } from '../components/market/MarketPulse.tsx'
import { NewsFeed } from '../components/market/NewsFeed.tsx'
import { SectorBars } from '../components/market/SectorBars.tsx'
import { StockTable } from '../components/market/StockTable.tsx'

export default function Dashboard() {
  const [scope, setScope] = useState<QuoteScope>('us')
  const [lastMarket, setLastMarket] = useState<Market>('us')
  const market = marketOfScope(scope, lastMarket)

  const onScopeChange = (next: QuoteScope) => {
    setScope(next)
    if (next !== 'watch') setLastMarket(next)
  }

  return (
    <div className="ws ws-market">
      <div className="area-pulse">
        <MarketPulse market={market} />
      </div>
      <div className="area-sectors">
        <SectorBars market={market} />
      </div>
      <div className="area-macro">
        <MacroPanel />
      </div>
      <section className="area-quotes" aria-label="시세 모니터">
        <StockTable scope={scope} onScopeChange={onScopeChange} />
      </section>
      <aside className="area-news">
        <NewsFeed />
      </aside>
    </div>
  )
}
