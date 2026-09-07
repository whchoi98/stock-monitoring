/**
 * 브라우저 온라인 상태 — `navigator.onLine`을 `online`/`offline` 이벤트로 구독한다.
 * The browser's online state: `navigator.onLine` subscribed through the `online`/`offline` events.
 *
 * 상태 바의 "오프라인" 표시가 읽는다. 서비스 워커(PWA)가 앱 셸을 오프라인에서도 열어 주므로, 데이터가 멈춘 이유를
 * 사용자에게 알려야 한다 — 시세 폴링 실패 카드만으로는 "서버 장애"와 "내 연결 끊김"이 구분되지 않는다.
 * Read by the status bar's "오프라인" badge. Because the service worker (PWA) opens the app shell offline too, the user
 * must be told why the data stopped: a failed-poll card alone cannot distinguish "server down" from "my link is gone".
 *
 * 서버(테스트의 SSR 스냅샷)에서는 온라인으로 간주한다 / The server snapshot (tests' SSR path) assumes online.
 */
import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

const readOnline = () => navigator.onLine
const assumeOnline = () => true

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, readOnline, assumeOnline)
}
