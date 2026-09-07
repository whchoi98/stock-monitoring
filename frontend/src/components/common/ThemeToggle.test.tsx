/**
 * ThemeToggle 테스트 — 불변식이 핵심이다: `<html data-theme>`은 어떤 경로로도 비어서는 안 된다.
 * tokens.css가 이 속성이 붙은 `:root`에만 변수를 정의하므로, 비면 모든 색이 사라진다.
 * ThemeToggle tests; the invariant is what matters: `<html data-theme>` must never end up empty by any
 * path, because tokens.css defines its variables only on a `:root` carrying it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { ThemeToggle } from './ThemeToggle.tsx'

const STORAGE_KEY = 'stock-monitoring:theme'

beforeEach(() => {
  localStorage.clear()
  // index.html이 내보내는 초기 상태 / The initial state index.html ships
  document.documentElement.dataset.theme = 'dark'
})

describe('ThemeToggle', () => {
  it('테마가 바뀌면 브라우저 크롬용 theme-color 메타를 현재 `--bg` 토큰으로 맞춘다 / a theme change syncs the theme-color meta to the current `--bg` token', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('content', '#0b0e14')
    document.head.appendChild(meta)
    // jsdom은 tokens.css를 모르므로 테마별 `--bg`를 직접 심는다 / jsdom knows no tokens.css, so the per-theme `--bg` is planted
    document.documentElement.style.setProperty('--bg', '#eef1f6')
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button'))   // → light
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(meta.getAttribute('content')).toBe('#eef1f6')

    document.documentElement.style.setProperty('--bg', '#0b0e14')
    fireEvent.click(screen.getByRole('button'))   // → dark
    expect(meta.getAttribute('content')).toBe('#0b0e14')

    meta.remove()
    document.documentElement.style.removeProperty('--bg')
  })

  it('저장된 테마를 마운트 시 문서에 적용한다 / applies the stored theme on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'light')
    render(<ThemeToggle />)
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('클릭마다 테마를 뒤집고 저장한다 / flips and persists the theme on each click', () => {
    render(<ThemeToggle />)
    const button = screen.getByRole('button')

    fireEvent.click(button)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light')

    fireEvent.click(button)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')
  })

  it('저장값이 손상되고 속성도 없으면 다크로 복구한다 / recovers to dark when the stored value is junk and the attribute is gone', () => {
    localStorage.setItem(STORAGE_KEY, 'neon')
    document.documentElement.removeAttribute('data-theme')

    render(<ThemeToggle />)

    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
