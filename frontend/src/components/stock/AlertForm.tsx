/**
 * 가격 알림 폼 — 종목 헤더의 "알림" 버튼이 여는 인라인 팝오버. 목표가를 넣으면 현재가 기준으로 방향(상향/하향)이 정해지고,
 * 이 종목의 알림 목록(대기/발동)과 삭제가 함께 보인다. 판정은 셸의 `AlertsWatcher`가 한다.
 * The price-alert form, an inline popover behind the quote header's "알림" button. A target gets its direction (up/down)
 * from the current price; the symbol's alerts (pending/fired) and their delete buttons sit below. The shell's
 * `AlertsWatcher` does the evaluating.
 *
 * 첫 알림을 만들 때 브라우저 알림 권한을 **요청만** 한다 — 거절되면 토스트만 남는다.
 * Creating the first alert merely **asks** for notification permission; if refused, the toast alone remains.
 */
import { type FormEvent, useId, useState } from 'react'

import { addAlert, directionFor, removeAlert, useAlerts } from '../../lib/alertsStore.ts'
import { formatClock } from '../../lib/clock.ts'
import { formatPrice, type Currency } from '../../lib/format.ts'

export interface AlertFormProps {
  symbol: string
  /** 현재가 — 방향 결정과 안내 문구에 쓴다 / The current price, for the direction and the hint */
  price: number
  currency: Currency
}

/** 알림 권한이 미정이면 묻는다 (지원하지 않는 환경은 건너뛴다) / Ask for permission while undecided; skip where unsupported */
function requestNotificationPermission(): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
  try {
    void Notification.requestPermission()
  } catch {
    // 권한을 못 물어도 토스트는 동작한다 / Toasts work regardless
  }
}

export function AlertForm({ symbol, price, currency }: AlertFormProps) {
  const alerts = useAlerts().filter((alert) => alert.symbol === symbol)
  const pending = alerts.filter((alert) => alert.triggeredAt === undefined).length
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const target = Number(value)
    if (value.trim() === '' || !Number.isFinite(target) || target <= 0) {
      setError('0보다 큰 목표가를 입력하세요')
      return
    }
    addAlert(symbol, target, price)
    requestNotificationPermission()
    setValue('')
    setError(null)
  }

  const preview = value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0 ? directionFor(Number(value), price) : null

  return (
    <div className="alert-wrap">
      <button
        type="button"
        className={pending > 0 ? 'btn btn-accent' : 'btn'}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        알림{pending > 0 && ` ${pending}`}
      </button>
      {open && (
        <div className="alert-pop">
          <form className="alert-form" onSubmit={submit}>
            <label className="alert-label" htmlFor={inputId}>
              목표가
            </label>
            <input
              id={inputId}
              className="alert-input"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              placeholder={formatPrice(price, currency).replace(/,/g, '')}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <button type="submit" className="btn btn-primary">
              추가
            </button>
          </form>
          <p className="alert-hint">
            현재가 {formatPrice(price, currency)} 기준
            {preview !== null && (preview === 'above' ? ' · ▲ 상향 돌파 시 알림' : ' · ▼ 하향 돌파 시 알림')}
            {' · 시세 폴링(45초)으로 판정 · 이 브라우저에만 저장'}
          </p>
          {error !== null && (
            <p className="alert-error" role="alert">
              {error}
            </p>
          )}
          {alerts.length > 0 && (
            <ul className="alert-list">
              {alerts.map((alert) => (
                <li key={alert.id} className="alert-item">
                  <span className={alert.direction === 'above' ? 'up' : 'down'}>
                    {alert.direction === 'above' ? '▲ 상향' : '▼ 하향'}
                  </span>
                  <span className="mono">{formatPrice(alert.price, currency)}</span>
                  <span className="alert-state">
                    {alert.triggeredAt === undefined
                      ? '대기'
                      : `발동 ${formatClock(new Date(alert.triggeredAt).toISOString()) ?? ''}`}
                  </span>
                  <button
                    type="button"
                    className="toast-close"
                    aria-label={`${formatPrice(alert.price, currency)} 알림 삭제`}
                    onClick={() => removeAlert(alert.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
