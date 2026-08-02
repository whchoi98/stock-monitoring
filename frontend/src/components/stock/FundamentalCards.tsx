/**
 * 핵심 지표 6장 — 시가총액 · PER · EPS · 베타(US)/PBR(KR) · 거래량 · 평균 거래량 (스펙 6.2 ②).
 * The six fundamentals: market cap, P/E, EPS, beta (US) or PBR (KR), volume and average volume.
 *
 * **네 번째 카드는 시장에 따라 다르다**: 미국 종목은 베타(변동성 기준선이 지수인 시장의 관례),
 * 한국 종목은 PBR(TUI가 KR 화면에 쓰던 지표). 둘을 함께 보여주지 않는 것은 스펙이 6장으로 못박았기 때문이다.
 * **The fourth card depends on the market**: beta for US stocks (the convention where an index is the
 * volatility baseline) and PBR for Korean ones (what the TUI showed on its KR screen). They are not shown
 * side by side because the spec fixes the count at six.
 *
 * **결측 처리**: `pe_ratio`/`eps`/`beta`/`pbr`은 yfinance 부분 실패 시 null이고, `market_cap`은 null이 아니라
 * 0.0 센티널이다 (`api/types.ts`). 어느 쪽이든 "—"로 낸다 — 0을 시가총액 0원으로 표시하지 않는다.
 * **Missing values**: `pe_ratio`/`eps`/`beta`/`pbr` are null when yfinance partially fails, while
 * `market_cap` is a 0.0 sentinel rather than null (see `api/types.ts`). Either way an em dash is rendered;
 * a 0 never appears as a market cap of zero.
 *
 * `dividend_yield`는 6장에 들어가지 않으므로 표시하지 않는다 — 그 필드만 원시 분수(0.0044 === 0.44%)라
 * 100을 곱해야 하는데, 표시하지 않으면 이중 변환의 위험도 없다.
 * `dividend_yield` is not one of the six and so is not rendered: it is the one field on a raw-fraction scale
 * (0.0044 === 0.44%) needing a x100, and not showing it removes any chance of converting twice.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useStock } from '../../api/queries.ts'
import type { StockDetail } from '../../api/types.ts'
import { formatMarketCap, formatPrice, formatVolume } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

/** 값이 없을 때 표시하는 대시 — `lib/format.ts`의 것과 같은 문자 / The dash for a missing value, the same character `lib/format.ts` uses */
const EM_DASH = '—'

/** 비율 지표 (PER/베타/PBR) — 결측이면 "—", 있으면 2자리 / A ratio (P/E, beta, PBR): an em dash when missing, two decimals otherwise */
function formatRatio(value: number | null): string {
  return value === null || !Number.isFinite(value) ? EM_DASH : value.toFixed(2)
}

/** 핵심 지표 6장을 만든다 / Build the six fundamentals */
function cardsOf(detail: StockDetail): { label: string; value: string }[] {
  return [
    { label: '시가총액', value: formatMarketCap(detail.market_cap, detail.currency) },
    { label: 'PER', value: formatRatio(detail.pe_ratio) },
    {
      label: 'EPS',
      // EPS는 주당 금액이므로 통화 규칙을 따른다 (KRW 소수점 없음 / USD 2자리)
      // EPS is an amount per share, so it follows the currency rule (no decimals for KRW, two for USD)
      value:
        detail.eps === null || !Number.isFinite(detail.eps)
          ? EM_DASH
          : formatPrice(detail.eps, detail.currency),
    },
    detail.market === 'us'
      ? { label: '베타', value: formatRatio(detail.beta) }
      : { label: 'PBR', value: formatRatio(detail.pbr) },
    { label: '거래량', value: formatVolume(detail.volume) },
    { label: '평균 거래량', value: formatVolume(detail.avg_volume) },
  ]
}

export interface FundamentalCardsProps {
  /** 종목 심볼 — 그대로 F2 훅에 넘긴다 / The symbol, handed straight to the F2 hook */
  symbol: string
}

export function FundamentalCards({ symbol }: FundamentalCardsProps) {
  const { data, asOf, isLoading, error } = useStock(symbol)
  const queryClient = useQueryClient()

  // 상세를 쓰는 세 위젯이 공유하는 키 (`api/queries.ts`의 `['stock', symbol]`) / The key the three detail widgets share
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="핵심 지표를 불러오지 못했습니다" />

  return (
    <section className="fundamentals">
      {/* IndexCards(F4)와 같은 형식 — 카드 밖 제목 + 카드 그리드 / The same shape as F4's IndexCards: a title outside the cards, then a grid */}
      <div className="section-head">
        <h2 className="card-title">핵심 지표</h2>
        <AsOfBadge asOf={asOf} />
      </div>

      {isLoading || data === undefined ? (
        <Card>
          <Spinner />
        </Card>
      ) : (
        <div className="fundamental-grid">
          {cardsOf(data).map(({ label, value }) => (
            <Card key={label}>
              <p className="fundamental-label">{label}</p>
              <p className="fundamental-value">{value}</p>
            </Card>
          ))}
        </div>
      )}
    </section>
  )
}
