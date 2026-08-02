/**
 * 범위 게이지 — 저가~고가 구간 안에서 현재가의 위치를 점으로 찍는다 (Toss의 "1일/52주 미니 게이지").
 * A range gauge: it marks where the current price sits between a low and a high (Toss's "1-day / 52-week
 * mini gauge", spec 6.2 ②).
 *
 * 이름은 52주 게이지에서 왔지만 스펙이 요구하는 두 게이지(1일 저가~고가, 52주 저가~고가)가 같은
 * 모양이므로 한 컴포넌트를 라벨과 범위만 바꿔 두 번 쓴다.
 * The name comes from the 52-week gauge, but the two gauges the spec asks for (today's low-to-high and the
 * 52-week low-to-high) are the same shape, so one component is used twice with a different label and range.
 *
 * **퇴화한 범위를 그리지 않는다**: `week52_high`/`week52_low`는 조회 실패 시 0.0 센티널이고
 * (`api/types.ts`), 상장 첫날처럼 저가와 고가가 같을 수도 있다. 그때 `(price-low)/(high-low)`는
 * 0으로 나누기이므로 게이지 대신 "—"를 낸다 — 눈금 없는 막대를 그려 없는 정보를 있는 것처럼 보이게
 * 하지 않는다.
 * **A degenerate range is never drawn**: `week52_high`/`week52_low` are 0.0 sentinels when the lookup
 * failed (see `api/types.ts`), and a first trading day can put the low and the high at the same value. Then
 * `(price-low)/(high-low)` divides by zero, so an em dash replaces the gauge rather than a scaleless bar
 * pretending the information exists.
 *
 * 현재가가 범위를 벗어날 수 있다 (52주 값은 펀더멘털 캐시에서 오고 현재가는 45초 시세 캐시에서 온다 —
 * 신고가를 낸 장중에는 price > week52_high다). 위치는 0~100%로 가둔다.
 * The price can fall outside the range: the 52-week figures come from the fundamentals cache while the
 * price comes from the 45s quote cache, so an intraday record high makes price > week52_high. The marker's
 * position is clamped to 0-100%.
 */
import { formatPrice, type Currency } from '../../lib/format.ts'

export interface Week52BarProps {
  /** 게이지 이름 — "1일" / "52주" / The gauge's name: "1일" or "52주" */
  label: string
  /** 구간 하단 / The bottom of the range */
  low: number
  /** 구간 상단 / The top of the range */
  high: number
  /** 표시할 현재가 / The price to place */
  price: number
  /** 가격 통화 / The prices' currency */
  currency: Currency
}

export function Week52Bar({ label, low, high, price, currency }: Week52BarProps) {
  const usable = Number.isFinite(low) && Number.isFinite(high) && high > low && low > 0

  return (
    <div className="range-gauge">
      <span className="range-label">{label}</span>
      {!usable ? (
        <span className="range-empty">—</span>
      ) : (
        <>
          <span className="range-low">{formatPrice(low, currency)}</span>
          <span className="range-track">
            <span
              className="range-marker"
              style={{ left: `${Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100))}%` }}
            />
          </span>
          <span className="range-high">{formatPrice(high, currency)}</span>
        </>
      )}
    </div>
  )
}
