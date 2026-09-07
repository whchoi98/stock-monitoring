/**
 * 데이터 표 — 차트의 "표" 뷰. 캔들을 최신순으로 시각·시가·고가·저가·종가·등락률·거래량 열에 늘어놓는다.
 * The data-table view of the chart: candles newest first with time, open, high, low, close, change and volume.
 *
 * 등락률은 직전 캔들 종가 대비다 (`summarizeCandle`) — 첫(가장 오래된) 캔들은 "—".
 * The change is against the previous candle's close (`summarizeCandle`); the oldest candle shows an em dash.
 */
import type { Candle } from '../../api/types.ts'
import { arrow, changeClass, formatPct, formatPrice, formatVolume, type Currency } from '../../lib/format.ts'
import { summarizeCandle } from './indicators.ts'

export interface CandleTableProps {
  candles: Candle[]
  currency: Currency
}

export function CandleTable({ candles, currency }: CandleTableProps) {
  // 최신순 인덱스 — 요약은 원본 순서(오래된→최신)의 인덱스로 구한다 / Newest first; the summary needs the original (oldest-first) index
  const indices = candles.map((_, index) => index).reverse()

  return (
    <div className="table-scroll candle-scroll">
      <table className="candle-table">
        <thead>
          <tr>
            <th scope="col">시각</th>
            <th scope="col" className="cell-number">
              시가
            </th>
            <th scope="col" className="cell-number">
              고가
            </th>
            <th scope="col" className="cell-number">
              저가
            </th>
            <th scope="col" className="cell-number">
              종가
            </th>
            <th scope="col" className="cell-number">
              등락률
            </th>
            <th scope="col" className="cell-number">
              거래량
            </th>
          </tr>
        </thead>
        <tbody>
          {indices.map((index) => {
            const summary = summarizeCandle(candles, index)
            if (summary === null) return null
            const kind = summary.change === null ? 'flat' : changeClass(summary.change)
            return (
              <tr key={summary.time} className={kind}>
                <td className="cell-time">{summary.time.replace('T', ' ')}</td>
                <td className="cell-number">{formatPrice(summary.open, currency)}</td>
                <td className="cell-number">{formatPrice(summary.high, currency)}</td>
                <td className="cell-number">{formatPrice(summary.low, currency)}</td>
                <td className="cell-number cell-strong">{formatPrice(summary.close, currency)}</td>
                <td className={`cell-number ${kind}`}>
                  {summary.changePct === null
                    ? '—'
                    : kind === 'flat'
                      ? '0.00%'
                      : `${arrow(summary.change ?? 0)}${formatPct(summary.changePct)}`}
                </td>
                <td className="cell-number">{formatVolume(summary.volume)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
