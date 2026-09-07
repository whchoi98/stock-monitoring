/**
 * StatusBar 테스트 — 폴링 문구가 상수에서 오는 것과 기준 시각 칩의 유무를 못박는다.
 * StatusBar tests, pinning that the polling wording comes from the constants and when the as-of chip shows.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatusBar } from './StatusBar.tsx'

describe('StatusBar', () => {
  it('출처·폴링 주기·시뮬레이션 안내·시계를 렌더한다 / renders source, cadence, simulation notice and clock', () => {
    render(<StatusBar marketOpen={true} />)
    expect(screen.getByText('Yahoo Finance')).toBeTruthy()
    expect(screen.getByText('시세 45s · 뉴스 120s 폴링')).toBeTruthy()
    expect(screen.getByText('호가·수급 시뮬레이션')).toBeTruthy()
    expect(screen.getByText('장중')).toBeTruthy()
    expect(screen.getByText(/KST$/)).toBeTruthy()
  })

  it('asOf가 있으면 기준 시각 칩을 렌더한다 / renders the as-of chip when asOf is given', () => {
    render(<StatusBar marketOpen={false} asOf="2026-08-03T05:32:00+00:00" />)
    expect(screen.getByTitle('데이터 기준 시각 2026-08-03T05:32:00+00:00').textContent).toMatch(
      /^기준 \d{2}:\d{2}$/,
    )
  })

  it('asOf가 없으면 칩을 렌더하지 않는다 / renders no chip without asOf', () => {
    render(<StatusBar marketOpen={undefined} />)
    expect(screen.queryByTitle(/데이터 기준 시각/)).toBeNull()
    expect(screen.getByText('확인 중')).toBeTruthy()
  })
})
