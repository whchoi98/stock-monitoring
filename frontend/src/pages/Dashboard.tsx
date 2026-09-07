/**
 * 시장 워크스페이스 `/` — 시장 펄스 · 섹터 등락 · 시세 표(두 칸) · 뉴스 와이어(우측 열, sticky).
 * The market workspace at `/`: market pulse, sector heat, the quote monitor (two cells) and the news wire (right
 * column, sticky).
 *
 * 데이터는 각 위젯이 자기 훅으로 직접 가져간다 (개요를 쓰는 두 위젯은 쿼리 키 `['overview']`를 셸의 스트립과
 * 공유하므로 요청은 한 번만 나간다). 이 페이지가 소유하는 유일한 상태는 시장 탭이며, 펄스·섹터·표를 함께 바꾼다.
 * Each widget fetches through its own hook; the two overview widgets share the `['overview']` key with the shell's
 * strip, so exactly one request goes out. The only state this page owns is the market tab, which switches the pulse,
 * the sectors and the table together.
 */
import { useState } from 'react'

import type { Market } from '../api/types.ts'
import { MarketPulse } from '../components/market/MarketPulse.tsx'
import { NewsFeed } from '../components/market/NewsFeed.tsx'
import { SectorBars } from '../components/market/SectorBars.tsx'
import { StockTable } from '../components/market/StockTable.tsx'

export default function Dashboard() {
  const [market, setMarket] = useState<Market>('us')

  return (
    <div className="ws ws-market">
      <div className="area-pulse">
        <MarketPulse market={market} />
      </div>
      <div className="area-sectors">
        <SectorBars market={market} />
      </div>
      <section className="area-quotes" aria-label="시세 모니터">
        <StockTable market={market} onMarketChange={setMarket} />
      </section>
      <aside className="area-news">
        <NewsFeed />
      </aside>
    </div>
  )
}
