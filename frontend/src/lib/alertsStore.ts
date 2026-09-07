/**
 * 가격 알림 — 목표가를 위(상향) 또는 아래(하향)로 돌파하면 한 번 알린다. 브라우저(localStorage)에만 저장된다.
 * Price alerts: fire once when the price crosses a target upward or downward. Stored in the browser (localStorage) only.
 *
 * 판정은 순수 함수 `evaluateAlerts`가 한다 — 시세 폴링(45초)마다 셸의 `AlertsWatcher`가 부른다. 발동한 알림은
 * `triggeredAt`이 채워지고 다시 울리지 않는다(삭제는 사용자가).
 * `evaluateAlerts`, a pure function, decides; the shell's `AlertsWatcher` calls it on every quote poll (45s). A fired
 * alert gets `triggeredAt` and never fires again (the user deletes it).
 */
import { createLocalStore, useLocalStore } from './localStore.ts'

export const ALERTS_KEY = 'stock-monitoring:alerts'

export type AlertDirection = 'above' | 'below'

export interface PriceAlert {
  id: string
  symbol: string
  /** 목표가 (종목 통화) / The target price in the symbol's currency */
  price: number
  direction: AlertDirection
  /** 생성 시각 (epoch ms) / Creation time (epoch ms) */
  createdAt: number
  /** 발동 시각 — 아직이면 없음 / When it fired; absent while pending */
  triggeredAt?: number
  /** 발동 당시 가격 / The price at which it fired */
  triggeredPrice?: number
}

function isAlert(raw: unknown): raw is PriceAlert {
  if (raw === null || typeof raw !== 'object') return false
  const record = raw as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['symbol'] === 'string' &&
    typeof record['price'] === 'number' &&
    Number.isFinite(record['price']) &&
    (record['direction'] === 'above' || record['direction'] === 'below') &&
    typeof record['createdAt'] === 'number'
  )
}

function parseAlerts(raw: unknown): PriceAlert[] | null {
  if (!Array.isArray(raw)) return null
  return raw.filter(isAlert)
}

export const alertsStore = createLocalStore<PriceAlert[]>(ALERTS_KEY, [], parseAlerts)

/**
 * 목표가의 방향 — 현재가보다 높으면 상향 돌파, 낮거나 같으면 하향 돌파.
 * The direction of a target: above the current price means an upward cross, at or below a downward one.
 */
export function directionFor(target: number, current: number): AlertDirection {
  return target > current ? 'above' : 'below'
}

/** 알림을 만든다 / Create an alert */
export function addAlert(symbol: string, price: number, current: number, now = Date.now()): PriceAlert {
  const alert: PriceAlert = {
    id: `${symbol}-${now}-${Math.random().toString(36).slice(2, 8)}`,
    symbol,
    price,
    direction: directionFor(price, current),
    createdAt: now,
  }
  alertsStore.set([...alertsStore.get(), alert])
  return alert
}

export function removeAlert(id: string): void {
  alertsStore.set(alertsStore.get().filter((alert) => alert.id !== id))
}

/**
 * 시세로 알림을 판정한다 — 새로 발동한 알림만 돌려준다 (순수 함수).
 * Evaluate the alerts against quotes, returning only the newly fired ones (pure).
 *
 * `prices`는 심볼 → 현재가. 시세가 없는 종목은 건너뛴다(모르는 것은 발동하지 않는다).
 * `prices` maps symbol to last price; a symbol with no quote is skipped (unknown never fires).
 */
export function evaluateAlerts(
  alerts: readonly PriceAlert[],
  prices: ReadonlyMap<string, number>,
  now: number,
): PriceAlert[] {
  const fired: PriceAlert[] = []
  for (const alert of alerts) {
    if (alert.triggeredAt !== undefined) continue
    const price = prices.get(alert.symbol)
    if (price === undefined || !Number.isFinite(price)) continue
    const crossed = alert.direction === 'above' ? price >= alert.price : price <= alert.price
    if (crossed) fired.push({ ...alert, triggeredAt: now, triggeredPrice: price })
  }
  return fired
}

/** 발동 결과를 저장한다 / Persist the fired alerts */
export function markTriggered(fired: readonly PriceAlert[]): void {
  if (fired.length === 0) return
  const byId = new Map(fired.map((alert) => [alert.id, alert]))
  alertsStore.set(alertsStore.get().map((alert) => byId.get(alert.id) ?? alert))
}

export function useAlerts(): PriceAlert[] {
  return useLocalStore(alertsStore)
}
