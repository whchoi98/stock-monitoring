/**
 * 시장 토글 (미국 / 한국) — 시장 화면의 세 패널과 종목 화면의 워치리스트가 같은 컨트롤을 쓴다.
 * The market toggle (US / KR), shared by the market screen's three panels and the stock screen's watchlist.
 *
 * 탭 대신 `role="group"` + `aria-pressed` 토글 버튼을 쓴다 — tablist/tab 롤은 tabpanel 배선까지 요구하는데
 * 이 컨트롤은 한 패널이 아니라 여러 위젯의 데이터를 함께 바꾸므로 그 모델과 맞지 않는다.
 * Toggle buttons in a labelled group rather than tablist/tab roles: those imply a tabpanel relationship, and this
 * control switches the data of several widgets at once, which that model does not fit.
 */
import type { Market } from '../../api/types.ts'
import { MARKET_LABEL } from '../../lib/markets.ts'

const MARKETS: Market[] = ['us', 'kr']

export interface MarketTabsProps {
  value: Market
  onChange: (market: Market) => void
}

export function MarketTabs({ value, onChange }: MarketTabsProps) {
  return (
    <div className="tabs" role="group" aria-label="시장 선택">
      {MARKETS.map((market) => (
        <button
          key={market}
          type="button"
          className={market === value ? 'tab tab-active' : 'tab'}
          aria-pressed={market === value}
          onClick={() => onChange(market)}
        >
          {MARKET_LABEL[market]}
        </button>
      ))}
    </div>
  )
}
