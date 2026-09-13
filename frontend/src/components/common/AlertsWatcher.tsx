/**
 * 가격 알림 감시 — 셸에 한 번 마운트된다. 대기 알림이 있을 때만 두 시장 공유 키를 `useQuotes`로 폴링하고,
 * 폴링마다 `evaluateAlerts`로 판정해 발동한 알림을 토스트(+ 권한이 있으면 시스템 알림)로 알린다.
 * The price-alert watcher, mounted once in the shell. Only while pending alerts exist does it poll both markets'
 * shared quote keys with `useQuotes`; on each poll it runs `evaluateAlerts` and announces the fired alerts as
 * toasts (plus a system notification when permission was granted).
 *
 * 발동은 스토어에 기록되므로(`markTriggered`) 새로고침해도 같은 알림이 다시 울리지 않는다.
 * Firing is recorded in the store (`markTriggered`), so a reload never re-fires the same alert.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { useQuotes, useSymbolUniverse } from '../../api/queries.ts'
import { evaluateAlerts, markTriggered, type PriceAlert, useAlerts } from '../../lib/alertsStore.ts'
import { formatPrice, type Currency } from '../../lib/format.ts'

/** 토스트가 스스로 사라지기까지 / How long a toast stays */
const TOAST_MS = 10_000

interface Fired {
  alert: PriceAlert
  currency: Currency
}

function describe(fired: Fired): string {
  const { alert, currency } = fired
  const direction = alert.direction === 'above' ? '상향' : '하향'
  const now = alert.triggeredPrice === undefined ? '' : ` · 현재 ${formatPrice(alert.triggeredPrice, currency)}`
  return `${alert.symbol} 목표가 ${formatPrice(alert.price, currency)} ${direction} 돌파${now}`
}

/** 시스템 알림 — 권한이 이미 있을 때만, 실패는 무시 / A system notification, only with permission already granted; failures ignored */
function notifySystem(fired: Fired[]): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  for (const item of fired) {
    try {
      new Notification('가격 알림', { body: describe(item), tag: item.alert.id })
    } catch {
      // 알림 생성 실패는 토스트가 이미 대신한다 / The toast already covers a failed notification
    }
  }
}

function Toast({ fired, onDismiss }: { fired: Fired; onDismiss: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDismiss, TOAST_MS)
    return () => clearTimeout(id)
  }, [onDismiss])

  return (
    <div className="toast" role="status">
      <span className={`toast-dot ${fired.alert.direction === 'above' ? 'up' : 'down'}`} aria-hidden="true">
        ●
      </span>
      <span className="toast-text">{describe(fired)}</span>
      <Link className="toast-link" to={`/stocks/${fired.alert.symbol}`} onClick={onDismiss}>
        보기
      </Link>
      <button type="button" className="toast-close" aria-label="알림 닫기" onClick={onDismiss}>
        ×
      </button>
    </div>
  )
}

export function AlertsWatcher() {
  const alerts = useAlerts()
  const hasPending = alerts.some((alert) => alert.triggeredAt === undefined)
  useQuotes('us', { enabled: hasPending })
  useQuotes('kr', { enabled: hasPending })
  const { quotes } = useSymbolUniverse(hasPending)
  const [toasts, setToasts] = useState<Fired[]>([])

  useEffect(() => {
    if (!hasPending || quotes.length === 0) return
    const prices = new Map(quotes.map((quote) => [quote.symbol, quote.price]))
    const fired = evaluateAlerts(alerts, prices, Date.now())
    if (fired.length === 0) return
    // 먼저 기록한다 — 스토어 갱신이 이 이펙트를 다시 돌려도 발동된 알림은 건너뛴다 / Record first: the store update re-runs this effect, which then skips the fired ones
    markTriggered(fired)
    const currencies = new Map(quotes.map((quote) => [quote.symbol, quote.currency]))
    const items = fired.map((alert) => ({ alert, currency: currencies.get(alert.symbol) ?? 'USD' }))
    setToasts((prev) => [...prev, ...items])
    notifySystem(items)
  }, [alerts, hasPending, quotes])

  if (toasts.length === 0) return null

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((fired) => (
        <Toast
          key={fired.alert.id}
          fired={fired}
          onDismiss={() => setToasts((prev) => prev.filter((item) => item.alert.id !== fired.alert.id))}
        />
      ))}
    </div>
  )
}
