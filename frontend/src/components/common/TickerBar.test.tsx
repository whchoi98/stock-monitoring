/**
 * TickerBar 테스트 — 지표가 없을 때(로딩/실패) 앱을 막지 않는 것과 단위 표기가 핵심이다.
 * TickerBar tests; the essentials are never blocking the app when indicators are absent
 * (loading or failed) and the unit notation.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Indicator } from '../../api/types.ts'
import { TickerBar } from './TickerBar.tsx'

const OIL: Indicator = {
  symbol: 'CL=F',
  name: 'WTI Oil',
  value: 78.5,
  change: 0.92,
  change_pct: 1.19,
  unit: '$',
}

const TNX: Indicator = {
  symbol: '^TNX',
  name: 'US 10Y',
  value: 4.25,
  change: -0.03,
  change_pct: -0.7,
  unit: '%',
}

describe('TickerBar', () => {
  it('지표가 없으면 아무것도 렌더하지 않는다 / renders nothing without indicators', () => {
    const { container } = render(<TickerBar indicators={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('$ 단위는 앞에, 나머지 단위는 뒤에 붙인다 / puts $ before the value and other units after', () => {
    render(<TickerBar indicators={[OIL, TNX]} />)
    expect(screen.getAllByText('$78.50').length).toBeGreaterThan(0)
    expect(screen.getAllByText('4.25%').length).toBeGreaterThan(0)
  })

  it('지표명과 등락을 함께 렌더한다 / renders the name alongside the change', () => {
    render(<TickerBar indicators={[OIL, TNX]} />)
    expect(screen.getAllByText('WTI Oil').length).toBeGreaterThan(0)
    expect(screen.getAllByText('▲+0.92 (+1.19%)').length).toBeGreaterThan(0)
    expect(screen.getAllByText('▼-0.03 (-0.70%)').length).toBeGreaterThan(0)
  })

  it('무한 스크롤용 사본은 스크린리더에서 숨긴다 / hides the seamless-scroll copy from screen readers', () => {
    const { container } = render(<TickerBar indicators={[OIL]} />)
    // 트랙을 한 벌 복제해 끊김 없이 순환시키므로, 사본은 aria-hidden이어야 중복 낭독이 없다.
    // The track is duplicated so the loop never gaps; the copy must be aria-hidden to avoid double reading.
    expect(screen.getAllByText('WTI Oil')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
  })

  it('asOf가 있으면 HH:MM 기준 칩을 렌더한다 / renders the HH:MM clock chip when asOf is given', () => {
    render(<TickerBar indicators={[OIL]} asOf="2026-08-03T05:32:00+00:00" />)
    const clock = screen.getByTitle('데이터 기준 시각 2026-08-03T05:32:00+00:00')
    // 시간대는 실행 환경에 따라 다르므로 형식만 고정한다 / The zone varies by host, so only the shape is pinned.
    expect(clock.textContent).toMatch(/^\d{2}:\d{2} 기준$/)
  })

  it('자정 시각을 24시가 아닌 00시로 렌더한다 / renders the midnight hour as 00, never 24', () => {
    /*
     * `hour12: false`는 h24 사이클로 해석되어 로컬 00:00~00:59 한 시간 전체가 `24:xx`로 새어 나온다.
     * 위 형식 테스트는 `\d{2}:\d{2}`라 `24:37`도 통과시키므로, 자정 시각을 직접 넣어 못을 박는다.
     * `hour12: false` resolves to the h24 cycle, leaking the whole local 00:00–00:59 hour as `24:xx`.
     * The shape test above admits `24:37`, so this pins the midnight hour explicitly.
     *
     * 호스트 시간대에 상관없이 "로컬 자정 시간대"에 떨어지는 순간을 만든다 / Build an instant inside the
     * host's local midnight hour, whatever the zone.
     */
    const midnight = new Date()
    midnight.setHours(0, 37, 0, 0)
    const iso = midnight.toISOString()
    // 기대값은 Intl이 아니라 Date에서 뽑는다 — `getHours()`는 24를 돌려주지 않는다.
    // The expectation comes from Date rather than Intl: `getHours()` never yields 24.
    const hh = String(midnight.getHours()).padStart(2, '0')
    const mm = String(midnight.getMinutes()).padStart(2, '0')

    render(<TickerBar indicators={[OIL]} asOf={iso} />)
    expect(screen.getByTitle(`데이터 기준 시각 ${iso}`).textContent).toBe(`${hh}:${mm} 기준`)
  })

  it('asOf가 없으면 칩을 렌더하지 않는다 / renders no chip without asOf', () => {
    render(<TickerBar indicators={[OIL]} />)
    expect(screen.queryByTitle(/데이터 기준 시각/)).toBeNull()
  })

  it('asOf가 파싱 불가면 칩을 렌더하지 않는다 / renders no chip for an unparseable asOf', () => {
    render(<TickerBar indicators={[OIL]} asOf="not-a-date" />)
    expect(screen.queryByTitle(/데이터 기준 시각/)).toBeNull()
  })

  it('지표가 없으면 asOf가 있어도 아무것도 렌더하지 않는다 / still renders nothing without indicators', () => {
    const { container } = render(<TickerBar indicators={[]} asOf="2026-08-03T05:32:00+00:00" />)
    expect(container.innerHTML).toBe('')
  })
})
