/**
 * UpdateToast 테스트 — 서비스 워커 상태(새 버전 대기 / 오프라인 준비)를 토스트로 알리고, 새로 고침이 워커 교체를 부른다.
 * UpdateToast tests: the service-worker states (a new version waiting / offline ready) surface as toasts, and the
 * refresh action asks the worker to take over.
 *
 * `virtual:pwa-register/react`는 빌드 시 vite-plugin-pwa가 만드는 가상 모듈이라 여기서는 통째로 가짜로 바꾼다.
 * `virtual:pwa-register/react` is a virtual module vite-plugin-pwa creates at build time, so it is replaced wholesale here.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRegisterSW } from 'virtual:pwa-register/react'
import { UpdateToast } from './UpdateToast.tsx'

vi.mock('virtual:pwa-register/react', () => ({ useRegisterSW: vi.fn() }))

type Registration = ReturnType<typeof useRegisterSW>

function registration(over: { needRefresh?: boolean; offlineReady?: boolean }): Registration & {
  setNeedRefresh: ReturnType<typeof vi.fn>
  setOfflineReady: ReturnType<typeof vi.fn>
  updateServiceWorker: ReturnType<typeof vi.fn>
} {
  const setNeedRefresh = vi.fn()
  const setOfflineReady = vi.fn()
  const updateServiceWorker = vi.fn(() => Promise.resolve())
  return {
    needRefresh: [over.needRefresh ?? false, setNeedRefresh],
    offlineReady: [over.offlineReady ?? false, setOfflineReady],
    updateServiceWorker,
    setNeedRefresh,
    setOfflineReady,
  } as unknown as Registration & {
    setNeedRefresh: ReturnType<typeof vi.fn>
    setOfflineReady: ReturnType<typeof vi.fn>
    updateServiceWorker: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  vi.mocked(useRegisterSW).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('UpdateToast', () => {
  it('아무 상태도 아니면 아무것도 그리지 않는다 / renders nothing when nothing is pending', () => {
    vi.mocked(useRegisterSW).mockReturnValue(registration({}))
    const { container } = render(<UpdateToast />)
    expect(container.innerHTML).toBe('')
  })

  it('새 버전이 대기 중이면 토스트를 띄우고 새로 고침이 워커를 교체한다 / a waiting version shows a toast whose refresh swaps the worker', () => {
    const reg = registration({ needRefresh: true })
    vi.mocked(useRegisterSW).mockReturnValue(reg)
    render(<UpdateToast />)

    expect(screen.getByRole('status').textContent).toContain('새 버전')
    fireEvent.click(screen.getByRole('button', { name: '새로 고침' }))
    // 라이브러리가 SKIP_WAITING을 보내고, 새 워커가 제어권을 잡으면(controlling) 페이지를 다시 읽는다 — 인자는 0.13.2부터 무시된다
    // The library posts SKIP_WAITING and reloads once the new worker takes control (controlling); the argument is ignored since 0.13.2
    expect(reg.updateServiceWorker).toHaveBeenCalledTimes(1)
    expect(reg.updateServiceWorker).toHaveBeenCalledWith()
  })

  it('닫기는 상태만 지우고 워커는 건드리지 않는다 / close clears the flag without touching the worker', () => {
    const reg = registration({ needRefresh: true })
    vi.mocked(useRegisterSW).mockReturnValue(reg)
    render(<UpdateToast />)

    fireEvent.click(screen.getByRole('button', { name: '새 버전 안내 닫기' }))
    expect(reg.setNeedRefresh).toHaveBeenCalledWith(false)
    expect(reg.updateServiceWorker).not.toHaveBeenCalled()
  })

  it('오프라인 준비가 끝나면 안내 토스트를 띄운다 / offline-ready shows an informational toast', () => {
    const reg = registration({ offlineReady: true })
    vi.mocked(useRegisterSW).mockReturnValue(reg)
    render(<UpdateToast />)

    expect(screen.getByRole('status').textContent).toContain('오프라인')
    fireEvent.click(screen.getByRole('button', { name: '오프라인 안내 닫기' }))
    expect(reg.setOfflineReady).toHaveBeenCalledWith(false)
  })

  it('오프라인 준비 안내는 8초 뒤 스스로 사라지고, 먼저 닫으면 타이머가 남지 않는다 / offline-ready dismisses itself after 8 s, and closing early leaves no timer', () => {
    vi.useFakeTimers()
    const reg = registration({ offlineReady: true })
    vi.mocked(useRegisterSW).mockReturnValue(reg)
    const view = render(<UpdateToast />)

    act(() => {
      vi.advanceTimersByTime(7_999)
    })
    expect(reg.setOfflineReady).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(reg.setOfflineReady).toHaveBeenCalledWith(false)

    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('두 안내가 동시에 뜨면 닫기 버튼의 이름이 서로 다르다 / when both notices show, their close buttons have distinct names', () => {
    const reg = registration({ needRefresh: true, offlineReady: true })
    vi.mocked(useRegisterSW).mockReturnValue(reg)
    render(<UpdateToast />)

    expect(screen.getAllByRole('status')).toHaveLength(2)
    expect(screen.getByRole('button', { name: '새 버전 안내 닫기' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '오프라인 안내 닫기' })).toBeTruthy()
    // 새 버전 점은 등락색이 아니라 시스템 액센트다 / The new-version dot uses the system accent, never a price colour
    expect(document.querySelector('.toast-dot.up')).toBeNull()
  })
})
