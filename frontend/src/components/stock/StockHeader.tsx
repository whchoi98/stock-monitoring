/**
 * 종목 헤더 (QUOTE HEADER) — 심볼·시장·섹터 태그, 종목명, 현재가(34px 고정폭), "전일 대비 ▲+N (N%)", 시가/고가/저가/
 * 전일종가/거래량 통계 셀, 1일/52주 게이지.
 * The quote header: symbol, market and sector tags, the name, the price at 34px mono, "전일 대비 ▲+N (N%)", the
 * open/high/low/previous-close/volume stat cells and the 1-day / 52-week gauges.
 *
 * 이 패널의 `<h1>`이 페이지 제목이다. 데이터는 훅으로 직접 가져가고, 같은 쿼리 키(`['stock', symbol]`)를 쓰는 다른
 * 위젯들과 요청 하나를 공유한다.
 * Its `<h1>` is the page's title. It fetches through the hook and shares one request with the other widgets on the
 * same query key (`['stock', symbol]`).
 */
import { useQueryClient } from '@tanstack/react-query'

import { useStock } from '../../api/queries.ts'
import { formatPrice, formatVolume, type Currency } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ChangeText } from '../common/ChangeText.tsx'
import { DataNotice } from '../common/DataNotice.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { MarketStatus } from '../common/MarketStatus.tsx'
import { MARKET_LABEL } from '../../lib/markets.ts'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { StarButton } from '../common/StarButton.tsx'
import { Stat } from '../common/Stat.tsx'
import { AlertForm } from './AlertForm.tsx'
import { Week52Bar } from './Week52Bar.tsx'

/**
 * 통계 셀의 가격 — 백엔드는 결측 가격을 0.0 센티널로 준다 (`_fast_float`; 장 시작 전 KR 종목의 시가/고가/저가가 그렇다).
 * 0원짜리 시가는 존재하지 않으므로 0 이하는 "—"로 낸다.
 * A stat-cell price. The backend sends a missing price as a 0.0 sentinel (`_fast_float`; a KR stock's open/high/low
 * before the session opens); no real open is zero, so zero or less renders as an em dash.
 */
function priceOrDash(value: number, currency: Currency): string {
  return Number.isFinite(value) && value > 0 ? formatPrice(value, currency) : '—'
}

export interface StockHeaderProps {
  /** 종목 심볼 — 그대로 훅에 넘긴다 / The symbol, handed straight to the hook */
  symbol: string
}

export function StockHeader({ symbol }: StockHeaderProps) {
  const { data, asOf, isLoading, marketOpen, error } = useStock(symbol)
  const queryClient = useQueryClient()

  // 상세를 쓰는 위젯들이 공유하는 키 — 한 번의 재시도로 함께 복구된다 / The key the detail widgets share; one retry heals all
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock', symbol] })
  }

  if (error !== null && data === undefined) {
    return <ErrorCard onRetry={retry} message={`${symbol} 정보를 불러오지 못했습니다`} />
  }

  if (isLoading || data === undefined) {
    return (
      <Panel eyebrow="QUOTE" title={symbol}>
        <Spinner />
      </Panel>
    )
  }

  return (
    <Panel className="qh">
      <DataNotice error={error} onRetry={retry} />
      <div className="qh-main">
        <div className="qh-identity">
          <div className="qh-symbol-row">
            <span className="qh-symbol">{data.symbol}</span>
            <StarButton symbol={data.symbol} />
            <span className="badge badge-accent">{data.market.toUpperCase()}</span>
            <span className="badge">{MARKET_LABEL[data.market]}</span>
            <MarketStatus market={data.market} marketOpen={error === null ? marketOpen : undefined} />
            {data.sector !== '' && <span className="badge">{data.sector}</span>}
          </div>
          <h1 className="qh-name">
            {data.name_ko?.trim() || data.name}
            {data.name_ko != null && data.name_ko !== data.name && (
              <span className="qh-name-ko">{data.name}</span>
            )}
          </h1>
        </div>

        <div className="qh-quote">
          <div className="qh-price-row">
            <p className="qh-price">{formatPrice(data.price, data.currency)}</p>
            <span className="qh-currency">{data.currency}</span>
          </div>
          {/* 마지막 거래일 종가 대비 / Relative to the previous trading session's close. */}
          <p className="qh-change">
            전일 대비 <ChangeText value={data.change} pct={data.change_pct} currency={data.currency} />
          </p>
          <div className="qh-quote-actions">
            <AsOfBadge asOf={asOf} />
            <AlertForm symbol={data.symbol} price={data.price} currency={data.currency} />
          </div>
        </div>
      </div>

      <div className="qh-stats">
        <Stat label="시가" value={priceOrDash(data.open_price, data.currency)} />
        <Stat label="고가" value={priceOrDash(data.high, data.currency)} />
        <Stat label="저가" value={priceOrDash(data.low, data.currency)} />
        <Stat label="전일종가" value={priceOrDash(data.prev_close, data.currency)} />
        <Stat label="거래량" value={formatVolume(data.volume)} />
      </div>

      <div className="qh-gauges">
        <Week52Bar label="1일" low={data.low} high={data.high} price={data.price} currency={data.currency} />
        <Week52Bar
          label="52주"
          low={data.week52_low}
          high={data.week52_high}
          price={data.price}
          currency={data.currency}
        />
      </div>
    </Panel>
  )
}
