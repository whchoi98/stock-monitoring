/**
 * 셸 알림 감시의 실제 폴링 — QueryClient·알림 스토어·컴포넌트를 그대로 쓰고 fetch 경계만 대체한다.
 * Exercise shell alert polling with the real QueryClient, alert store and component; only fetch is stubbed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QUOTE_POLL_MS, useQuotes } from '../../api/queries.ts'
import type { Market, Quote } from '../../api/types.ts'
import { addAlert, ALERTS_KEY, alertsStore, removeAlert, type PriceAlert } from '../../lib/alertsStore.ts'
import { AlertsWatcher } from './AlertsWatcher.tsx'

const AAPL: Quote = {
  symbol: 'AAPL',
  name: 'Apple',
  name_ko: '애플',
  price: 320,
  change: 1,
  change_pct: 0.3,
  volume: 1,
  market: 'us',
  currency: 'USD',
  sector: 'Technology',
  market_cap: null,
}
const SAMSUNG: Quote = {
  ...AAPL,
  symbol: '005930.KS',
  name: 'Samsung Electronics',
  name_ko: '삼성전자',
  price: 70_000,
  market: 'kr',
  currency: 'KRW',
}

function stubQuotes() {
  const requests: Record<Market, number> = { us: 0, kr: 0 }
  const quotes: Record<Market, Quote> = { us: { ...AAPL }, kr: { ...SAMSUNG } }
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((path) => {
    const market = new URL(String(path), 'http://localhost').searchParams.get('market') as Market
    requests[market]++
    return Promise.resolve(new Response(JSON.stringify({
      data: [quotes[market]],
      asOf: new Date().toISOString(),
      marketOpen: true,
    }), { status: 200 }))
  }))
  return { requests, quotes }
}

function stubNotifications(permission: NotificationPermission) {
  const delivered: { title: string; options?: NotificationOptions; stored: PriceAlert[] }[] = []
  const requestPermission = vi.fn().mockResolvedValue('granted')
  class TestNotification {
    static permission = permission
    static requestPermission = requestPermission

    constructor(title: string, options?: NotificationOptions) {
      delivered.push({
        title,
        options,
        stored: JSON.parse(localStorage.getItem(ALERTS_KEY) ?? '[]') as PriceAlert[],
      })
    }
  }
  vi.stubGlobal('Notification', TestNotification)
  return { delivered, requestPermission }
}

const clients: QueryClient[] = []

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: Infinity } },
  })
  clients.push(client)
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/articles']}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
  return { client, wrapper: Wrapper }
}

async function advance(ms = 1) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  alertsStore.reload()
})

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  alertsStore.set([])
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('AlertsWatcher polling without quote widgets', () => {
  it.each([
    { market: 'us', quote: AAPL, target: 330, crossed: 331, text: 'AAPL 목표가 330.00 상향 돌파 · 현재 331.00' },
    { market: 'kr', quote: SAMSUNG, target: 71_000, crossed: 72_000, text: '005930.KS 목표가 71,000 상향 돌파 · 현재 72,000' },
  ] as const)('단독 감시자의 $market 돌파 감지 / detects a later $market crossing with only the watcher mounted', async ({ market, quote, target, crossed, text }) => {
    const alert = addAlert(quote.symbol, target, quote.price)
    const { requests, quotes } = stubQuotes()
    const { delivered, requestPermission } = stubNotifications('granted')
    const { client, wrapper } = setup()
    render(<AlertsWatcher />, { wrapper })
    await advance()
    expect(requests).toEqual({ us: 1, kr: 1 })
    expect(screen.queryByRole('status')).toBeNull()
    expect(alertsStore.get()[0].triggeredAt).toBeUndefined()

    quotes[market] = { ...quote, price: crossed }
    await advance(QUOTE_POLL_MS)

    expect(requests).toEqual({ us: 2, kr: 2 })
    expect(screen.getByRole('status').textContent).toContain(text)
    expect(alertsStore.get()[0]).toMatchObject({
      id: alert.id, triggeredPrice: crossed, triggeredAt: expect.any(Number),
    })
    // 시스템 알림이 전달되기 전에 저장까지 끝나야 한다 / Persistence must precede notification delivery.
    expect(delivered).toHaveLength(1)
    expect(delivered[0].stored[0]).toMatchObject({
      id: alert.id, triggeredPrice: crossed, triggeredAt: expect.any(Number),
    })
    expect(delivered[0].options).toMatchObject({ tag: alert.id, body: text })
    expect(requestPermission).not.toHaveBeenCalled()
    expect(client.getQueryCache().getAll().map((query) => query.queryKey).sort()).toEqual([
      ['quotes', 'kr'], ['quotes', 'us'],
    ])

    await advance(QUOTE_POLL_MS * 2)
    expect(requests).toEqual({ us: 2, kr: 2 })
    expect(delivered).toHaveLength(1)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('추가·삭제에 맞춰 양 시장 폴링을 켜고 끈다 / starts and stops both polls as pending alerts are added and removed', async () => {
    const { requests } = stubQuotes()
    const { wrapper } = setup()
    render(<AlertsWatcher />, { wrapper })
    await advance(QUOTE_POLL_MS)
    expect(requests).toEqual({ us: 0, kr: 0 })

    let alert!: PriceAlert
    act(() => { alert = addAlert('AAPL', 340, 320) })
    await advance()
    expect(requests).toEqual({ us: 1, kr: 1 })
    await advance(QUOTE_POLL_MS)
    expect(requests).toEqual({ us: 2, kr: 2 })

    act(() => { removeAlert(alert.id) })
    await advance(QUOTE_POLL_MS * 2)
    expect(requests).toEqual({ us: 2, kr: 2 })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each(['default', 'denied'] as const)(
    '기존 권한 %s에서는 토스트만 제공하고 권한을 묻지 않는다 / never requests permission in the background',
    async (permission) => {
      const fired = addAlert('005930.KS', 71_000, 70_000)
      const pending = addAlert('AAPL', 1_000, 320)
      const { requests, quotes } = stubQuotes()
      const { delivered, requestPermission } = stubNotifications(permission)
      const { wrapper } = setup()
      const view = render(<AlertsWatcher />, { wrapper })
      await advance()
      quotes.kr = { ...SAMSUNG, price: 72_000 }
      await advance(QUOTE_POLL_MS)

      expect(screen.getAllByRole('status')).toHaveLength(1)
      const snapshot = alertsStore.get().find((alert) => alert.id === fired.id)
      expect(snapshot?.triggeredPrice).toBe(72_000)
      expect(requestPermission).not.toHaveBeenCalled()
      expect(delivered).toHaveLength(0)

      quotes.kr = { ...SAMSUNG, price: 73_000 }
      await advance(QUOTE_POLL_MS)
      expect(requests).toEqual({ us: 3, kr: 3 })
      expect(alertsStore.get().find((alert) => alert.id === fired.id)).toEqual(snapshot)
      expect(screen.queryByRole('status')).toBeNull()
      expect(requestPermission).not.toHaveBeenCalled()

      act(() => { removeAlert(pending.id) })
      view.unmount()
      alertsStore.reload()
      render(<AlertsWatcher />, { wrapper })
      await advance(QUOTE_POLL_MS * 2)
      expect(requests).toEqual({ us: 3, kr: 3 })
      expect(screen.queryByRole('status')).toBeNull()
      expect(requestPermission).not.toHaveBeenCalled()
    },
  )
})

describe('AlertsWatcher with another quote observer', () => {
  it('미국 시세 관찰자와 요청을 공유하며 한국 알림도 갱신한다 / shares US requests while independently refreshing a KR alert', async () => {
    addAlert('005930.KS', 71_000, 70_000)
    const { requests, quotes } = stubQuotes()
    stubNotifications('default')
    const { wrapper } = setup()
    const market = renderHook(() => useQuotes('us'), { wrapper })
    render(<AlertsWatcher />, { wrapper })
    await advance()
    expect(requests).toEqual({ us: 1, kr: 1 })
    expect(market.result.current.data?.[0].price).toBe(320)

    quotes.us = { ...AAPL, price: 321 }
    quotes.kr = { ...SAMSUNG, price: 72_000 }
    await advance(QUOTE_POLL_MS)

    expect(requests).toEqual({ us: 2, kr: 2 })
    expect(market.result.current.data?.[0].price).toBe(321)
    expect(screen.getByRole('status').textContent).toContain('005930.KS 목표가 71,000')
    expect(alertsStore.get()[0].triggeredPrice).toBe(72_000)

    await advance(QUOTE_POLL_MS)
    expect(requests).toEqual({ us: 3, kr: 2 })
  })
})
