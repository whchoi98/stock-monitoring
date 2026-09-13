/**
 * AlertsWatcher 테스트 — 대기 알림이 있을 때만 시세를 켜고, 돌파 시 토스트 1회 + 스토어 기록.
 * AlertsWatcher tests: quotes are enabled only with pending alerts; a crossing toasts once and is recorded.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSymbolUniverse } from '../../api/queries.ts'
import type { Quote } from '../../api/types.ts'
import { addAlert, alertsStore } from '../../lib/alertsStore.ts'
import { AlertsWatcher } from './AlertsWatcher.tsx'

vi.mock('../../api/queries.ts', () => ({ useQuotes: vi.fn(), useSymbolUniverse: vi.fn() }))

const AAPL: Quote = {
  symbol: 'AAPL',
  name: 'Apple',
  price: 331,
  change: 1,
  change_pct: 0.3,
  volume: 1,
  market: 'us',
  currency: 'USD',
  sector: '',
  market_cap: null,
}

function renderWatcher() {
  return render(
    <MemoryRouter>
      <AlertsWatcher />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  alertsStore.reload()
  vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [], isLoading: false, error: null })
})

describe('AlertsWatcher', () => {
  it('대기 알림이 없으면 시세를 켜지 않고 아무것도 그리지 않는다 / with no pending alert it enables nothing and renders nothing', () => {
    const { container } = renderWatcher()
    expect(vi.mocked(useSymbolUniverse)).toHaveBeenLastCalledWith(false)
    expect(container.innerHTML).toBe('')
  })

  it('돌파하면 토스트를 띄우고 스토어에 발동을 기록한다 (한 번만) / a crossing toasts and records the firing, once', () => {
    addAlert('AAPL', 330, 320)
    vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [AAPL], isLoading: false, error: null })

    const { rerender } = renderWatcher()

    expect(vi.mocked(useSymbolUniverse)).toHaveBeenCalledWith(true)
    const toast = screen.getByRole('status')
    expect(toast.textContent).toContain('AAPL 목표가 330.00 상향 돌파 · 현재 331.00')
    expect(screen.getByRole('link', { name: '보기' }).getAttribute('href')).toBe('/stocks/AAPL')
    expect(alertsStore.get()[0]!.triggeredAt).toBeDefined()

    // 다음 폴링(같은 가격)에서는 다시 울리지 않는다 / The next poll at the same price does not re-fire
    rerender(
      <MemoryRouter>
        <AlertsWatcher />
      </MemoryRouter>,
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)
    // 발동 뒤에는 대기 알림이 없으므로 시세를 끈다 / With nothing pending afterwards the quotes go off
    expect(vi.mocked(useSymbolUniverse)).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: '알림 닫기' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('목표가 미달이면 울리지 않는다 / no crossing, no toast', () => {
    addAlert('AAPL', 340, 320)
    vi.mocked(useSymbolUniverse).mockReturnValue({ quotes: [AAPL], isLoading: false, error: null })

    renderWatcher()

    expect(screen.queryByRole('status')).toBeNull()
    expect(alertsStore.get()[0]!.triggeredAt).toBeUndefined()
  })
})
