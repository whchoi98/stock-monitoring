/**
 * StatusBar 테스트 — 폴링 문구가 상수에서 오는 것과 기준 시각 칩의 유무를 못박는다.
 * StatusBar tests, pinning that the polling wording comes from the constants and when the as-of chip shows.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addAlert, alertsStore } from '../../lib/alertsStore.ts'
import { panelStore, togglePanel } from '../../lib/panelStore.ts'
import { StatusBar } from './StatusBar.tsx'

beforeEach(() => {
  localStorage.clear()
  alertsStore.reload()
  panelStore.reload()
})

afterEach(() => {
  // 스파이(navigator.onLine)가 실패한 단언 뒤에도 남지 않게 / So a spy (navigator.onLine) never outlives a failed assertion
  vi.restoreAllMocks()
})

describe('StatusBar', () => {
  it('브라우저가 오프라인이면 상태 바에 오프라인을 표시하고, 다시 연결되면 지운다 / shows an offline state while the browser is offline and clears it on reconnect', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<StatusBar marketOpen={true} />)
    expect(screen.getByText('오프라인')).toBeTruthy()

    onLine.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(screen.queryByText('오프라인')).toBeNull()
  })

  it('대기 알림 수를 보이고, 접힌 패널이 있으면 초기화 버튼이 전부 펼친다 / shows pending alerts; the reset button expands collapsed panels', () => {
    addAlert('AAPL', 330, 320)
    togglePanel('order-book')
    render(<StatusBar marketOpen={true} />)

    expect(screen.getByText('알림 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '레이아웃 초기화' }))
    expect(panelStore.get()).toEqual({})
    expect(screen.queryByRole('button', { name: '레이아웃 초기화' })).toBeNull()
  })

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
