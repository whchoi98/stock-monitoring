/** AlertForm 테스트 — 열기, 추가(방향), 검증 오류, 삭제 / Open, add (direction), validation, delete. */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { alertsStore } from '../../lib/alertsStore.ts'
import { AlertForm } from './AlertForm.tsx'

beforeEach(() => {
  localStorage.clear()
  alertsStore.reload()
})

describe('AlertForm', () => {
  it('버튼이 폼을 열고, 목표가를 넣으면 현재가 기준 방향으로 저장된다 / the button opens the form; a target is stored with its direction', () => {
    render(<AlertForm symbol="AAPL" price={320} currency="USD" />)

    fireEvent.click(screen.getByRole('button', { name: '알림' }))
    fireEvent.change(screen.getByLabelText('목표가'), { target: { value: '330' } })
    expect(screen.getByText(/▲ 상향 돌파 시 알림/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '추가' }))

    const stored = alertsStore.get()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ symbol: 'AAPL', price: 330, direction: 'above' })
    expect(screen.getByText('▲ 상향')).toBeTruthy()
    expect(screen.getByText('대기')).toBeTruthy()
    // 버튼 라벨에 대기 수가 붙는다 / The button now carries the pending count
    expect(screen.getByRole('button', { name: '알림 1' })).toBeTruthy()
  })

  it('하향 목표는 하향으로 / a target below the price is a downward alert', () => {
    render(<AlertForm symbol="005930.KS" price={266000} currency="KRW" />)
    fireEvent.click(screen.getByRole('button', { name: '알림' }))
    fireEvent.change(screen.getByLabelText('목표가'), { target: { value: '250000' } })
    fireEvent.click(screen.getByRole('button', { name: '추가' }))

    expect(alertsStore.get()[0]!.direction).toBe('below')
    expect(screen.getByText('250,000')).toBeTruthy()
  })

  it('빈 값·0 이하는 저장하지 않고 오류를 보인다 / empty or non-positive input is refused with an error', () => {
    render(<AlertForm symbol="AAPL" price={320} currency="USD" />)
    fireEvent.click(screen.getByRole('button', { name: '알림' }))
    fireEvent.click(screen.getByRole('button', { name: '추가' }))
    expect(screen.getByRole('alert').textContent).toContain('0보다 큰 목표가')

    fireEvent.change(screen.getByLabelText('목표가'), { target: { value: '-5' } })
    fireEvent.click(screen.getByRole('button', { name: '추가' }))
    expect(alertsStore.get()).toEqual([])
  })

  it('삭제 버튼이 알림을 지운다 / the delete button removes the alert', () => {
    render(<AlertForm symbol="AAPL" price={320} currency="USD" />)
    fireEvent.click(screen.getByRole('button', { name: '알림' }))
    fireEvent.change(screen.getByLabelText('목표가'), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: '추가' }))
    expect(alertsStore.get()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '300.00 알림 삭제' }))
    expect(alertsStore.get()).toEqual([])
  })
})
