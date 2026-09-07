/**
 * 서비스 워커 토스트 — 새 버전이 대기 중이면 "새로 고침"을, 오프라인 준비가 끝나면 안내를 띄운다.
 * The service-worker toast: offers "새로 고침" when a new version is waiting, and announces offline readiness.
 *
 * 워커는 `prompt` 방식으로 등록된다(`vite.config.ts`의 `registerType`): 새 워커가 스스로 페이지를 갈아치우지 않고
 * 사용자가 새로 고침을 누를 때만 교체한다 — AI 분석을 스트리밍 중인 화면이 저절로 다시 읽히면 안 된다.
 * The worker is registered in `prompt` mode (`registerType` in `vite.config.ts`): a new worker never swaps the page by
 * itself, only when the user presses refresh — a screen mid-way through an AI stream must not reload under them.
 *
 * `virtual:pwa-register/react`는 vite-plugin-pwa가 빌드 시 만드는 가상 모듈이다. vitest에서는 같은 플러그인이 dev용 no-op 모듈을
 * 서빙해 import가 해석된다(테스트는 `vi.mock`으로 통째로 바꾼다) — 플러그인을 test 모드에서 빼면 이 import가 깨진다.
 * `virtual:pwa-register/react` is a virtual module vite-plugin-pwa provides at build time; under vitest the same plugin
 * serves a dev no-op module so the import resolves (tests replace it with `vi.mock`) — dropping the plugin in test mode
 * would break this import.
 */
import { useEffect } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

/** 오프라인 준비 안내가 스스로 사라지기까지 / How long the offline-ready notice stays */
const OFFLINE_READY_MS = 8_000

export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error: unknown) {
      // 조용한 실패 금지 — 워커 등록 실패는 앱을 막지 않지만 기록은 남긴다 / No silent failure: a failed registration does not block the app but is logged
      console.warn(JSON.stringify({ event: 'sw_register_failed', error: String(error) }))
    },
  })

  useEffect(() => {
    if (!offlineReady) return
    const timer = window.setTimeout(() => setOfflineReady(false), OFFLINE_READY_MS)
    return () => window.clearTimeout(timer)
  }, [offlineReady, setOfflineReady])

  if (!needRefresh && !offlineReady) return null

  return (
    <div className="toasts toasts-left">
      {needRefresh && (
        <div className="toast" role="status">
          {/* 점은 시스템 액센트 — 등락색(`.up/.down`)은 가격 방향 전용 / The dot is the system accent; `.up/.down` are for price direction only */}
          <span className="toast-dot accent" aria-hidden="true">
            ●
          </span>
          <span className="toast-text">새 버전이 준비됐습니다</span>
          {/* 인자 없이 부른다 — 라이브러리가 SKIP_WAITING을 보내고 새 워커가 제어권을 잡으면 다시 읽는다 / No argument: the library posts SKIP_WAITING and reloads once the new worker controls the page */}
          <button type="button" className="toast-link" onClick={() => void updateServiceWorker()}>
            새로 고침
          </button>
          <button type="button" className="toast-close" aria-label="새 버전 안내 닫기" onClick={() => setNeedRefresh(false)}>
            ×
          </button>
        </div>
      )}
      {offlineReady && (
        <div className="toast" role="status">
          <span className="toast-dot" aria-hidden="true">
            ●
          </span>
          <span className="toast-text">오프라인에서도 열 수 있게 준비됐습니다</span>
          <button type="button" className="toast-close" aria-label="오프라인 안내 닫기" onClick={() => setOfflineReady(false)}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}
