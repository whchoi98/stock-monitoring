/**
 * 패널 접힘 상태 — 패널 `id` → 접힘 여부. 브라우저(localStorage)에만 저장된다. 상태 바의 "레이아웃 초기화"가 전부 지운다.
 * Collapsed-panel state, panel `id` → collapsed, stored in the browser only; the status bar's "레이아웃 초기화" clears it all.
 */
import { createLocalStore, useLocalStore } from './localStore.ts'

export const PANELS_KEY = 'stock-monitoring:panels'

type Collapsed = Record<string, boolean>

function parseCollapsed(raw: unknown): Collapsed | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Collapsed = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === true) out[key] = true
  }
  return out
}

export const panelStore = createLocalStore<Collapsed>(PANELS_KEY, {}, parseCollapsed)

export function togglePanel(id: string): void {
  const current = panelStore.get()
  const next = { ...current }
  if (next[id] === true) delete next[id]
  else next[id] = true
  panelStore.set(next)
}

/** 모든 패널을 펼친다 / Expand every panel */
export function resetPanels(): void {
  panelStore.set({})
}

export function usePanelCollapsed(id: string | undefined): boolean {
  const collapsed = useLocalStore(panelStore)
  return id !== undefined && collapsed[id] === true
}

/** 접힌 패널 수 — 상태 바의 초기화 버튼 표시 여부 / How many panels are collapsed; drives the reset button */
export function useCollapsedCount(): number {
  return Object.keys(useLocalStore(panelStore)).length
}
