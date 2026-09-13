/**
 * 시각 표기 테스트 — 자정을 24시로 새는 h24 회귀와 KST 고정을 못박는다.
 * Clock formatting tests, pinning the midnight-as-24 regression and the fixed KST zone.
 */
import { describe, expect, it } from 'vitest'

import { formatClock, formatKstClock } from './clock.ts'

describe('formatClock', () => {
  it('HH:MM 형식이다 / is HH:MM', () => {
    expect(formatClock('2026-08-03T05:32:00+00:00')).toBe('14:32')
  })

  it('자정 시각을 24시가 아닌 00시로 낸다 / renders the midnight hour as 00, never 24', () => {
    // 브라우저 시간대와 무관하게 서울 자정 / Seoul midnight regardless of the browser zone.
    expect(formatClock('2026-09-12T15:37:00Z')).toBe('00:37')
  })

  it('파싱 불가면 null / null when unparseable', () => {
    expect(formatClock('not-a-date')).toBeNull()
  })
})

describe('formatKstClock', () => {
  it('UTC 00:00:00을 서울 09:00:00으로 낸다 / renders UTC midnight as 09:00:00 in Seoul', () => {
    expect(formatKstClock(Date.parse('2026-09-06T00:00:00Z'))).toBe('09:00:00')
  })

  it('서울 자정도 00시로 낸다 / renders Seoul midnight as 00 too', () => {
    expect(formatKstClock(Date.parse('2026-09-06T15:00:05Z'))).toBe('00:00:05')
  })
})
