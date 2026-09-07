/**
 * 종목 워크스페이스 `/stocks/:symbol` — 워치리스트 레일 · 중앙(헤더 → 차트 → AI 리서치 → 핵심지표/기간수익률 → 뉴스) ·
 * 우측(호가 → 수급). 1280px 미만에서는 레일이 접히고, 900px 미만에서는 1열로 쌓인다.
 * The stock workspace: a watchlist rail, the centre (header, chart, AI research, fundamentals/returns, news) and the
 * side column (order book, investor flow). The rail folds below 1280px; below 900px everything stacks.
 *
 * **각 위젯이 자기 데이터를 가져간다.** 상세를 쓰는 넷(헤더 · 핵심 지표 · 기간수익률 · 이 페이지)은 쿼리 키
 * `['stock', symbol]`을 공유하므로 요청은 한 번만 나가고, 한 위젯의 실패가 다른 위젯을 끌어내리지 않는다.
 * **Every widget fetches its own data.** The four detail consumers share the `['stock', symbol]` key, so one request
 * goes out and one widget's failure never drags another down.
 *
 * 이 페이지가 훅을 부르는 이유는 둘이다 — 차트 가격축의 **통화**와 워치리스트의 **시장**. 어느 쪽도 심볼 접미사로
 * 추측하지 않는다 (백엔드의 시장 분류를 프론트에 복제하지 않기 위해).
 * The page's own hook call serves two things: the chart axis's **currency** and the watchlist's **market**. Neither is
 * guessed from the symbol suffix.
 */
import { useMemo } from 'react'
import { useParams } from 'react-router-dom'

import { useStock } from '../api/queries.ts'
import { Panel } from '../components/common/Panel.tsx'
import { Spinner } from '../components/common/Spinner.tsx'
import { AIPanel } from '../components/stock/AIPanel.tsx'
import { FundamentalCards } from '../components/stock/FundamentalCards.tsx'
import { InvestorPanel } from '../components/stock/InvestorPanel.tsx'
import { OrderBook } from '../components/stock/OrderBook.tsx'
import { PriceChart } from '../components/stock/PriceChart.tsx'
import { ReturnsRow } from '../components/stock/ReturnsRow.tsx'
import { StockHeader } from '../components/stock/StockHeader.tsx'
import { StockNews } from '../components/stock/StockNews.tsx'
import { Watchlist } from '../components/stock/Watchlist.tsx'

/**
 * 라우트 파라미터를 확인하고 본문에 넘긴다 — 확인은 **훅을 부르기 전에** 끝내야 빈 심볼로 `/api/stocks/`를 두드리는
 * 경로가 생기지 않는다 (훅에는 `enabled`가 없다). 심볼의 점(`005930.KS`)은 react-router가 그대로 넘겨준다.
 * Check the route parameter before any hook runs, so no path hits `/api/stocks/` with an empty symbol (the hooks take
 * no `enabled` flag). A dot inside the symbol passes through react-router untouched.
 */
export default function StockDetail() {
  const { symbol } = useParams<'symbol'>()

  if (symbol === undefined || symbol === '') {
    return <p className="empty">종목을 지정해 주세요</p>
  }

  return <StockDetailBody symbol={symbol} />
}

function StockDetailBody({ symbol }: { symbol: string }) {
  // 통화와 시장만 쓴다 — 로딩/실패 표시는 각 위젯이 스스로 한다 / Only the currency and market are read; each widget shows its own state
  const { data } = useStock(symbol)

  // 차트 기준선 — 전일종가·52주 고/저. 세 숫자가 같으면 같은 객체를 넘겨 차트가 선을 다시 그리지 않게 한다.
  // Chart levels: previous close and 52-week high/low, memoised so the chart redraws its lines only when a number changes.
  const hasDetail = data !== undefined
  const prevClose = data?.prev_close
  const week52High = data?.week52_high
  const week52Low = data?.week52_low
  const levels = useMemo(
    () => (hasDetail ? { prevClose, week52High, week52Low } : undefined),
    [hasDetail, prevClose, week52High, week52Low],
  )

  return (
    <div className="ws ws-stock">
      <aside className="ws-rail" aria-label="워치리스트">
        {data === undefined ? (
          <Panel eyebrow="WATCHLIST">
            <Spinner />
          </Panel>
        ) : (
          // 시장이 바뀌는 심볼 전환(US→KR)에는 레일을 다시 마운트해 초기 시장을 갱신한다 / A cross-market switch remounts the rail so its initial market follows
          <Watchlist key={data.market} initialMarket={data.market} selected={symbol} />
        )}
      </aside>

      <div className="ws-center">
        <StockHeader symbol={symbol} />
        <PriceChart symbol={symbol} currency={data?.currency} levels={levels} />
        {/*
          AI 리서치는 차트 바로 아래 넓은 열에 앉는다 — 마크다운(표 포함)은 320px 우측 열에서 읽기 어렵고, 첫 화면 안에
          들어와야 기능이 발견된다. 이 패널만 `key`로 심볼에 묶는다: 다른 위젯은 react-query가 심볼별 키로 상태를 갈아
          주지만, AI는 스트리밍 훅의 컴포넌트 상태(누적 텍스트·결과)를 들고 있어서 리마운트 없이는 이전 종목의 분석이 새
          종목 화면에 남는다.
          AI research sits right under the chart in the wide column: markdown (tables included) does not read in a 320px
          side column, and the feature has to land above the fold to be discovered. Only this panel is tied to the symbol
          with a `key`: every other widget gets its state swapped by react-query's per-symbol keys, while the AI panel
          holds the streaming hook's component state.
        */}
        <AIPanel key={symbol} symbol={symbol} />
        <div className="duo">
          <FundamentalCards symbol={symbol} />
          <ReturnsRow symbol={symbol} />
        </div>
        <StockNews symbol={symbol} />
      </div>

      <div className="ws-side">
        <OrderBook symbol={symbol} />
        <InvestorPanel symbol={symbol} />
      </div>
    </div>
  )
}
