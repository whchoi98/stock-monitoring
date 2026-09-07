/**
 * 가격 알림 테스트 — 방향 결정, 돌파 판정(1회), 저장·손상 복구 / Price alert tests: direction, crossing (once), persistence.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  addAlert,
  ALERTS_KEY,
  alertsStore,
  directionFor,
  evaluateAlerts,
  markTriggered,
  removeAlert,
  type PriceAlert,
} from './alertsStore.ts'

const NOW = Date.parse('2026-09-07T01:00:00Z')

function alert(over: Partial<PriceAlert>): PriceAlert {
  return { id: 'a1', symbol: 'AAPL', price: 330, direction: 'above', createdAt: NOW - 1000, ...over }
}

beforeEach(() => {
  localStorage.clear()
  alertsStore.reload()
})

describe('directionFor', () => {
  it('현재가보다 높은 목표는 상향, 낮거나 같으면 하향 / above the current price is up, at or below is down', () => {
    expect(directionFor(330, 320)).toBe('above')
    expect(directionFor(310, 320)).toBe('below')
    expect(directionFor(320, 320)).toBe('below')
  })
})

describe('evaluateAlerts', () => {
  it('상향 알림은 목표가 이상에서, 하향은 이하에서 발동한다 / up fires at or above, down at or below', () => {
    const alerts = [alert({ id: 'up', price: 330, direction: 'above' }), alert({ id: 'down', price: 300, direction: 'below' })]

    expect(evaluateAlerts(alerts, new Map([['AAPL', 320]]), NOW)).toEqual([])
    expect(evaluateAlerts(alerts, new Map([['AAPL', 330]]), NOW).map((a) => a.id)).toEqual(['up'])
    expect(evaluateAlerts(alerts, new Map([['AAPL', 299.5]]), NOW).map((a) => a.id)).toEqual(['down'])
  })

  it('발동한 알림에는 시각과 가격이 기록되고 다시 울리지 않는다 / a fired alert records time and price and never fires again', () => {
    const fired = evaluateAlerts([alert({})], new Map([['AAPL', 331]]), NOW)
    expect(fired[0]!.triggeredAt).toBe(NOW)
    expect(fired[0]!.triggeredPrice).toBe(331)

    expect(evaluateAlerts(fired, new Map([['AAPL', 340]]), NOW + 45_000)).toEqual([])
  })

  it('시세가 없는 종목은 건너뛴다 / a symbol without a quote is skipped', () => {
    expect(evaluateAlerts([alert({ symbol: 'ZZZ' })], new Map([['AAPL', 999]]), NOW)).toEqual([])
    expect(evaluateAlerts([alert({})], new Map([['AAPL', Number.NaN]]), NOW)).toEqual([])
  })
})

describe('alertsStore', () => {
  it('추가·삭제가 저장된다 / add and remove persist', () => {
    const created = addAlert('AAPL', 330, 320, NOW)
    expect(created.direction).toBe('above')
    expect(alertsStore.get()).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(ALERTS_KEY) ?? '[]')).toHaveLength(1)

    removeAlert(created.id)
    expect(alertsStore.get()).toEqual([])
  })

  it('markTriggered는 해당 알림만 갱신한다 / markTriggered updates only the fired alerts', () => {
    const a = addAlert('AAPL', 330, 320, NOW)
    const b = addAlert('MSFT', 400, 500, NOW)
    const fired = evaluateAlerts(alertsStore.get(), new Map([['AAPL', 331]]), NOW + 1)
    markTriggered(fired)

    const stored = alertsStore.get()
    expect(stored.find((x) => x.id === a.id)?.triggeredAt).toBe(NOW + 1)
    expect(stored.find((x) => x.id === b.id)?.triggeredAt).toBeUndefined()
  })

  it('손상된 항목은 버린다 / junk entries are dropped', () => {
    localStorage.setItem(
      ALERTS_KEY,
      JSON.stringify([alert({}), { id: 'bad' }, { ...alert({ id: 'nan' }), price: 'x' }]),
    )
    alertsStore.reload()
    expect(alertsStore.get().map((x) => x.id)).toEqual(['a1'])
  })
})
