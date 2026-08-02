/**
 * 주요 지수 카드 — S&P 500 / NASDAQ / DOW / KOSPI / KOSDAQ 5장을 그리드로 (스펙 6.2).
 * The index cards: S&P 500, NASDAQ, DOW, KOSPI and KOSDAQ in a five-card grid (spec 6.2).
 *
 * 개수를 5로 가정하지 않는다 — 백엔드가 주는 만큼 렌더한다 (일부 조회 실패 시 더 적을 수 있다).
 * The count is never assumed to be five: it renders what the backend sends, which can be fewer when a
 * lookup partially fails.
 */
import { useQueryClient } from '@tanstack/react-query'

import { useOverview } from '../../api/queries.ts'
import { formatPrice } from '../../lib/format.ts'
import { AsOfBadge } from '../common/AsOfBadge.tsx'
import { Card } from '../common/Card.tsx'
import { ChangeText } from '../common/ChangeText.tsx'
import { ErrorCard } from '../common/ErrorCard.tsx'
import { Spinner } from '../common/Spinner.tsx'

export function IndexCards() {
  const { data, asOf, isLoading, error } = useOverview()
  const queryClient = useQueryClient()

  /*
   * F2 훅은 `refetch`를 노출하지 않으므로(계약: `{data, asOf, marketOpen, isLoading, error}`)
   * 재시도는 이 위젯의 쿼리 키만 무효화한다 — 키는 `api/queries.ts`의 `['overview']`와 같아야 한다.
   * 개요를 쓰는 세 위젯(지수/시장요약/섹터)은 같은 키를 공유하므로 한 번의 재시도로 함께 복구된다.
   * The F2 hooks expose no `refetch`, so a retry invalidates just this widget's key, which must mirror
   * `['overview']` in `api/queries.ts`. The three overview widgets share that key, so one retry heals all.
   */
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
  }

  if (error !== null) return <ErrorCard onRetry={retry} message="지수를 불러오지 못했습니다" />

  const indices = data?.indices ?? []

  return (
    <section className="index-section">
      <div className="section-head">
        <h2 className="card-title">주요 지수</h2>
        <AsOfBadge asOf={asOf} />
      </div>

      {isLoading ? (
        <Card>
          <Spinner />
        </Card>
      ) : indices.length === 0 ? (
        <Card>
          <p className="empty">지수 데이터가 없습니다</p>
        </Card>
      ) : (
        <div className="index-grid">
          {indices.map((index) => (
            <Card key={index.symbol}>
              <p className="index-name">{index.name}</p>
              {/* 지수는 통화가 없다 — 소수 2자리(USD 규칙)로 통일 / Indices carry no currency, so the 2-decimal USD rule applies */}
              <p className="index-value">{formatPrice(index.value, 'USD')}</p>
              <ChangeText value={index.change} pct={index.change_pct} />
            </Card>
          ))}
        </div>
      )}
    </section>
  )
}
