/** 브라우저 표 밀도 설정 / Browser-only table density preferences. */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QUOTE_DENSITY_KEY, quoteDensityStore, useQuoteDensity } from './quotePreferences.ts'

beforeEach(() => {
  localStorage.clear()
  quoteDensityStore.reload()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('quote density preferences', () => {
  it('remembers the chosen density through the existing local store', () => {
    const { result } = renderHook(useQuoteDensity)
    expect(result.current).toBe('comfortable')
    act(() => quoteDensityStore.set('compact'))
    act(() => quoteDensityStore.reload())
    expect(result.current).toBe('compact')
    expect(JSON.parse(localStorage.getItem(QUOTE_DENSITY_KEY) ?? 'null')).toBe('compact')
  })

  it.each(['not json', '"dense"', 'true', 'null', '[]', '{"density":"compact"}'])(
    'falls back safely for invalid saved preferences: %s',
    (raw) => {
      localStorage.setItem(QUOTE_DENSITY_KEY, raw)
      quoteDensityStore.reload()
      expect(quoteDensityStore.get()).toBe('comfortable')
    },
  )

  it('updates mounted views after a density change in another tab', () => {
    const { result } = renderHook(useQuoteDensity)
    localStorage.setItem(QUOTE_DENSITY_KEY, '"compact"')
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: QUOTE_DENSITY_KEY })))
    expect(result.current).toBe('compact')
    localStorage.removeItem(QUOTE_DENSITY_KEY)
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: QUOTE_DENSITY_KEY })))
    expect(result.current).toBe('comfortable')
  })

  it('keeps the selected density usable when browser persistence is denied', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied') })
    const { result } = renderHook(useQuoteDensity)
    act(() => quoteDensityStore.set('compact'))
    expect(result.current).toBe('compact')
  })
})
