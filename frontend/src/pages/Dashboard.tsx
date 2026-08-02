/**
 * 대시보드 `/` — 스펙 6.2 ①의 배치: 지수 카드 → 시장요약 + 섹터 등락 → US/KR 탭 시세 표 → 우측 뉴스.
 * The dashboard at `/`, laid out per spec 6.2 ①: index cards, summary plus sectors, the US/KR tabbed quote
 * table, and news on the right.
 *
 * 데이터는 각 위젯이 F2 훅으로 직접 가져간다 (개요를 쓰는 세 위젯은 쿼리 키 `['overview']`를 공유하므로
 * 요청은 한 번만 나간다 — 셸의 티커 바까지 같은 캐시를 쓴다). 이 페이지가 소유하는 유일한 상태는
 * 시장 탭이며, 시세 표뿐 아니라 시장요약·섹터 카드까지 함께 바꾼다 (세 위젯 모두 시장별 데이터다).
 * Each widget fetches through its own F2 hook; the three overview widgets share the `['overview']` query
 * key, so exactly one request goes out (the shell's ticker bar reads the same cache). The only state this
 * page owns is the market tab, which switches the summary and sector cards along with the table, since all
 * three hold per-market data.
 */
import { useState } from 'react'

import type { Market } from '../api/types.ts'
import { IndexCards } from '../components/market/IndexCards.tsx'
import { MarketSummary } from '../components/market/MarketSummary.tsx'
import { NewsFeed } from '../components/market/NewsFeed.tsx'
import { SectorBars } from '../components/market/SectorBars.tsx'
import { StockTable } from '../components/market/StockTable.tsx'

const MARKETS: { value: Market; label: string }[] = [
  { value: 'us', label: '미국' },
  { value: 'kr', label: '한국' },
]

export default function Dashboard() {
  const [market, setMarket] = useState<Market>('us')

  return (
    <div className="dashboard">
      <div className="dashboard-main">
        <IndexCards />

        <div className="dashboard-duo">
          <MarketSummary market={market} />
          <SectorBars market={market} />
        </div>

        <section className="dashboard-quotes">
          {/*
            탭 대신 `role="group"` + `aria-pressed` 토글 버튼을 쓴다 — tablist/tab 롤은 tabpanel 배선까지
            요구하는데 이 탭은 아래 표만이 아니라 위 카드들까지 함께 바꾸므로 그 모델과 맞지 않는다.
            Toggle buttons in a labelled group rather than tablist/tab roles: those roles imply a tabpanel
            relationship, and this control also switches the cards above it, which that model does not fit.
          */}
          <div className="tabs" role="group" aria-label="시장 선택">
            {MARKETS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className={value === market ? 'tab tab-active' : 'tab'}
                aria-pressed={value === market}
                onClick={() => setMarket(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <StockTable market={market} />
        </section>
      </div>

      <aside className="dashboard-side">
        <NewsFeed />
      </aside>
    </div>
  )
}
