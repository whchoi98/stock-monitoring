/**
 * localStorage 기반 외부 스토어 — 관심 종목·가격 알림·패널 접힘처럼 **브라우저에만 사는 사용자 상태**의 공통 뼈대.
 * A localStorage-backed external store: the shared skeleton for user state that lives only in the browser (watchlist,
 * price alerts, collapsed panels).
 *
 * 규칙 / Rules:
 * - 읽기 실패(사파리 프라이빗 모드, 손상된 JSON)는 `fallback`으로, 쓰기 실패는 세션 메모리로만 동작한다 — `ThemeToggle`과 같은 관용.
 *   A failed read (Safari private mode, corrupt JSON) yields `fallback`; a failed write keeps working in memory for the session.
 * - 스냅샷은 값이 바뀔 때만 새 참조가 된다 — `useSyncExternalStore`가 불필요한 재렌더 없이 동작하는 전제다.
 *   The snapshot changes reference only when the value changes, which is what `useSyncExternalStore` relies on.
 * - 다른 탭의 변경은 `storage` 이벤트로 따라온다 (첫 구독자가 생길 때 한 번 등록).
 *   Another tab's change arrives through the `storage` event, registered once when the first subscriber appears.
 * - 서버 상태가 아니다 — react-query 규칙의 대상이 아니다. 백엔드는 이 값을 모른다.
 *   This is not server state and not subject to the react-query rule; the backend never sees these values.
 */
import { useSyncExternalStore } from 'react'

export interface LocalStore<T> {
  /** 현재 스냅샷 / The current snapshot */
  get(): T
  /** 새 값으로 바꾸고 저장·통지한다 / Replace, persist and notify */
  set(next: T): void
  /** 구독 — 해제 함수를 돌려준다 / Subscribe; returns the unsubscribe */
  subscribe(listener: () => void): () => void
  /** 저장소에서 다시 읽는다 (다른 탭의 변경, 테스트) / Re-read from storage (another tab's change, tests) */
  reload(): void
}

/**
 * 스토어를 만든다 / Create a store.
 *
 * @param key localStorage 키 / The localStorage key
 * @param fallback 읽을 수 없을 때의 값 / The value when nothing usable is stored
 * @param parse 저장된 JSON을 검증해 `T`로, 아니면 null / Validate the stored JSON into a `T`, or null
 */
export function createLocalStore<T>(
  key: string,
  fallback: T,
  parse: (raw: unknown) => T | null,
): LocalStore<T> {
  const listeners = new Set<() => void>()
  let storageBound = false

  const read = (): T => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return fallback
      return parse(JSON.parse(raw)) ?? fallback
    } catch {
      return fallback
    }
  }

  let snapshot: T = read()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return
    snapshot = read()
    emit()
  }

  return {
    get: () => snapshot,
    set: (next) => {
      snapshot = next
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // 저장 실패는 이번 세션 동작에 영향이 없다 / A failed write does not affect this session
      }
      emit()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      if (!storageBound && typeof window !== 'undefined') {
        window.addEventListener('storage', onStorage)
        storageBound = true
      }
      return () => {
        listeners.delete(listener)
      }
    },
    reload: () => {
      snapshot = read()
      emit()
    },
  }
}

/** 스토어를 React 상태로 / A store as React state */
export function useLocalStore<T>(store: LocalStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** 문자열 배열만 통과시키는 파서 / A parser that admits only an array of strings */
export function parseStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  return raw.filter((item): item is string => typeof item === 'string')
}
