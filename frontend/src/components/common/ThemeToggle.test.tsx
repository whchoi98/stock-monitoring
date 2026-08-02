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
