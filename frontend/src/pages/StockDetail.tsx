/**
 * 종목 상세 `/stocks/:symbol` — 스펙 6.2 ②의 배치: Toss형 헤더 + 위젯 카드 그리드.
 * The stock detail page at `/stocks/:symbol`, laid out per spec 6.2 ②: a Toss-style header plus a grid of
 * widget cards.
 *
 * 그리드는 2열이고 차트만 두 칸을 차지한다 (캔들은 폭이 있어야 읽힌다). 나머지는 호가 · 투자자 동향 ·
 * 핵심 지표 6장 · 기간수익률 · 종목 뉴스 · AI 분석이 각각 한 칸이다. 모바일에서는 1열로 쌓인다.
 * The grid is two columns wide and only the chart spans both (candles need width to read). The order book,
 * the investor panel, the six fundamentals, the period returns, the news and the AI panel each take one
 * cell. On mobile it stacks into a single column.
 *
 * **각 위젯이 자기 데이터를 가져간다** (F4가 대시보드에 세운 관례). 상세를 쓰는 셋(헤더 · 핵심 지표 ·
 * 기간수익률)과 이 페이지는 쿼리 키 `['stock', symbol]`을 공유하므로 요청은 한 번만 나가고, 한 위젯의
 * 실패가 다른 위젯을 끌어내리지 않는다 (스펙 7: 위젯 단위 에러 + 재시도).
 * **Every widget fetches its own data**, the convention F4 set on the dashboard. The three detail-derived
 * widgets (header, fundamentals, returns) and this page share the query key `['stock', symbol]`, so exactly
 * one request goes out, and one widget's failure never drags another down (spec 7: per-widget errors with a
 * retry).
 *
 * 이 페이지가 훅을 부르는 유일한 이유는 **통화**다 — 차트 엔드포인트는 통화를 담지 않으므로 가격축의
 * 소수점 자리를 정하려면 상세의 `currency`를 차트에 넘겨야 한다 (`PriceChart`의 `currency` 프롭).
 * The page's own hook call exists for one reason: the **currency**. The chart endpoint carries none, so the
 * price axis's decimals depend on handing the detail's `currency` down (`PriceChart`'s `currency` prop).
 */
import { useParams } from 'react-router-dom'

import { useStock } from '../api/queries.ts'
import { AIPanel } from '../components/stock/AIPanel.tsx'
import { FundamentalCards } from '../components/stock/FundamentalCards.tsx'
import { InvestorPanel } from '../components/stock/InvestorPanel.tsx'
import { OrderBook } from '../components/stock/OrderBook.tsx'
import { PriceChart } from '../components/stock/PriceChart.tsx'
import { ReturnsRow } from '../components/stock/ReturnsRow.tsx'
import { StockHeader } from '../components/stock/StockHeader.tsx'
import { StockNews } from '../components/stock/StockNews.tsx'

/**
 * 라우트 파라미터를 확인하고 본문에 넘긴다 / Check the route parameter and hand it to the body.
 *
 * 파라미터는 타입상 optional이다 (`useParams`는 어떤 라우트에서 불릴지 모른다). 실제로는
 * `/stocks/:symbol`에서만 렌더되므로 값이 있지만, 확인은 **훅을 부르기 전에** 끝내야 한다 —
 * 그래야 빈 심볼로 `/api/stocks/`를 두드리는 경로가 아예 생기지 않는다 (F2 훅에는 `enabled`가 없다).
 * 그래서 파라미터 확인과 데이터 소비를 두 컴포넌트로 나눈다.
 * 심볼에 점이 들어가는 것(`005930.KS`)은 react-router가 그대로 넘겨준다.
 * The parameter is optional in the type system (`useParams` cannot know which route calls it). In practice
 * this page only renders under `/stocks/:symbol`, so it is present — but the check has to finish **before any
 * hook runs**, so that no path exists that hits `/api/stocks/` with an empty symbol (the F2 hooks take no
 * `enabled` flag). Hence the split between checking the parameter and consuming the data. A dot inside the
 * symbol (`005930.KS`) passes through react-router untouched.
 */
export default function StockDetail() {
  const { symbol } = useParams<'symbol'>()

  if (symbol === undefined || symbol === '') {
    return <p className="empty">종목을 지정해 주세요</p>
  }

  return <StockDetailBody symbol={symbol} />
}

function StockDetailBody({ symbol }: { symbol: string }) {
  // 통화만 쓴다 — 로딩/실패 표시는 각 위젯이 스스로 한다 / Only the currency is read here; each widget shows its own loading and failure state
  const { data } = useStock(symbol)

  return (
    <div className="detail">
      <StockHeader symbol={symbol} />

      <div className="detail-grid">
        <div className="detail-wide">
          <PriceChart symbol={symbol} currency={data?.currency} />
        </div>
        <OrderBook symbol={symbol} />
        <InvestorPanel symbol={symbol} />
        {/*
          핵심 지표는 한 칸 안에서 6장이 자체 그리드로 접힌다 (`.fundamental-grid`) — 브리프가 두 칸을 준
          위젯은 차트뿐이고, 그래야 위젯 8칸이 4행 2열로 빈 칸 없이 맞는다.
          The six fundamentals fold into their own grid inside one cell (`.fundamental-grid`): the brief gives
          two columns to the chart alone, and that is what makes the eight cells fill four rows with no gap.
        */}
        <FundamentalCards symbol={symbol} />
        <ReturnsRow symbol={symbol} />
        <StockNews symbol={symbol} />
        <AIPanel symbol={symbol} />
      </div>
    </div>
  )
}
