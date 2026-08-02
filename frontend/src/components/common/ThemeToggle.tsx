/**
 * 테마 토글 — `<html data-theme>`만 바꾼다. 색은 전부 토큰이라 이 한 속성이 테마의 전부다.
 * The theme toggle; it only flips `<html data-theme>`. Every colour is a token, so this single
 * attribute is the whole theme.
 *
 * **불변식**: `data-theme`은 항상 `dark` 또는 `light`여야 한다 — tokens.css는 이 속성이 붙은
 * `:root`에만 변수를 정의하므로, 속성을 지우면 모든 색이 사라진다. 그래서 어떤 경로로도
 * 속성을 제거하지 않고 기본값은 다크로 되돌린다.
 * **Invariant**: `data-theme` must always be `dark` or `light`. tokens.css defines its variables only
 * on a `:root` carrying that attribute, so removing it would erase every colour. No path here ever
 * removes it; the fallback is dark.
 */
import { useEffect, useState } from 'react'

type Theme = 'dark' | 'light'

const STORAGE_KEY = 'stock-monitoring:theme'

/** 기본 테마 — 스펙상 다크 우선 / The default theme; the spec puts dark first */
const DEFAULT_THEME: Theme = 'dark'

/**
 * 저장된 선택 → 현재 문서 속성 → 다크 순으로 초기 테마를 정한다.
 * The initial theme comes from the stored choice, then the document's current attribute, then dark.
 *
 * localStorage 접근은 사파리 프라이빗 모드 등에서 throw할 수 있어 감싼다.
 * Accessing localStorage can throw (Safari private mode among others), so it is guarded.
 */
function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // 저장소를 못 읽으면 문서 속성으로 폴백한다 / Fall back to the document attribute when storage is unreadable
  }
  return document.documentElement.dataset.theme === 'light' ? 'light' : DEFAULT_THEME
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // 저장 실패는 이번 세션 동작에 영향이 없다 / A failed write does not affect this session
    }
  }, [theme])

  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={next === 'light' ? '라이트 모드로 전환' : '다크 모드로 전환'}
      onClick={() => setTheme(next)}
    >
      {next === 'light' ? '라이트' : '다크'}
    </button>
  )
}
