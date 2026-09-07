/**
 * 핵심 지표 (FUNDAMENTALS) — 시가총액 · PER · EPS · 베타(US)/PBR(KR) · 거래량 · 평균 거래량, 통계 셀 6개.
 * The six fundamentals as stat cells: market cap, P/E, EPS, beta (US) or PBR (KR), volume and average volume.
 *
 * **네 번째 셀은 시장에 따라 다르다**: 미국 종목은 베타, 한국 종목은 PBR. 둘을 함께 보여주지 않는 것은 스펙이
 * 6개로 못박았기 때문이다.
 * **The fourth cell depends on the market**: beta for US stocks, PBR for Korean ones; the spec fixes the count at six.
 *
 * **결측 처리**: `pe_ratio`/`eps`/`beta`/`pbr`은 null이고 `market_cap`은 0.0 센티널이다 (`api/types.ts`). 어느 쪽이든
 * "—"로 낸다. `dividend_yield`는 6개에 들지 않아 표시하지 않는다 — 표시하게 되면 퍼센트 스케일(0.35 === 0.35%)이므로
 * 100을 곱하지 말 것.
 * **Missing values** render as an em dash whether null or the 0.0 sentinel. `dividend_yield` is not shown; should it
 * ever be, it is percent-scale and must not be multiplied by 100.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useStock } from '../../api/queries.ts'
import type { StockDetail } from '../../api/types.ts'
import { formatMarketCap, formatPrice, formatVolume } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Panel } from '../common/Panel.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Stat } from '../common/Stat.tsx'

/** 값이 없을 때 표시하는 대시 — `lib/format.ts`의 것과 같은 문자 / The dash for a missing value */
const EM_DASH = '—'

/** 비율 지표 (PER/베타/PBR) — 결측이면 "—", 있으면 2자리 / A ratio: an em dash when missing, two decimals otherwise */
function formatRatio(value: number | null): string {
  return value === null || !Number.isFinite(value) ? EM_DASH : value.toFixed(2)
}

/** 핵심 지표 6개를 만든다 / Build the six fundamentals */
function cellsOf(detail: StockDetail): { label: string; value: string }[] {
  return [
    { label: '시가총액', value: formatMarketCap(detail.market_cap, detail.currency) },
    { label: 'PER', value: formatRatio(detail.pe_ratio) },
    {
      label: 'EPS',
      // EPS는 주당 금액이므로 통화 규칙을 따른다 / EPS is an amount per share, so it follows the currency rule
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
  /** 종목 심볼 — 그대로 훅에 넘긴다 / The symbol, handed straight to the hook */
  symbol: string
}

export function FundamentalCards({ symbol }: FundamentalCardsProps) {
  const { data, asOf, isLoading, error } = useStock(symbol)
  const queryClient = useQueryClient()

  // 상세를 쓰는 위젯들이 공유하는 키 (`api/queries.ts`의 `['stock', symbol]`) / The key the detail widgets share
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock', symbol] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="핵심 지표를 불러오지 못했습니다" />

  return (
    <Panel id="fundamentals" eyebrow="FUNDAMENTALS" title="핵심 지표" action={<AsOfBadge asOf={asOf} />}>
      {isLoading || data === undefined ? (
        <Spinner />
      ) : (
        <div className="stat-grid">
          {cellsOf(data).map(({ label, value }) => (
            <Stat key={label} label={label} value={value} />
          ))}
        </div>
      )}
    </Panel>
  )
}
